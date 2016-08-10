'use strict'

/**
 * @module
 */

const path = require('path')
const co = require('co')
const crypto = require('crypto')
const semver = require('semver')
const matchRequire = require('match-require')
const mime = require('mime')
const debug = require('debug')('oceanify')

const postcss = require('postcss')
const atImport = require('postcss-import')
const autoprefixer = require('autoprefixer')

const fs = require('./lib/fs')
const parseMap = require('./lib/parseMap')
const parseSystem = require('./lib/parseSystem')
const define = require('./lib/define')
const compileAll = require('./lib/compileAll')
const compileStyleSheets = require('./lib/compileStyleSheets')
const findComponent = require('./lib/findComponent')
const findModule = require('./lib/findModule')
const Cache = require('./lib/Cache')

const loaderPath = path.join(__dirname, 'loader.js')
const loaderSource = fs.readFileSync(loaderPath, 'utf8')
const loaderStats = fs.statSync(loaderPath)

const RE_EXT = /(\.(?:css|js))$/i
const RE_ASSET_EXT = /\.(?:gif|jpg|jpeg|png|svg|swf|ico)$/i

const exists = fs.exists
const readFile = fs.readFile
const lstat = fs.lstat


/**
 * @typedef  {Module}
 * @type     {Object}
 * @property {string} name
 * @property {string} version
 * @property {string} entry
 *
 * @typedef  {DependenciesMap}
 * @type     {Object}
 *
 * @typedef  {System}
 * @type     {Object}
 * @property {Object} dependencies
 * @property {Object} modules
 *
 * @typedef  {uAST}
 * @type     {Object}
 */

/**
 * @param  {string} id
 * @param  {Object} system
 *
 * @returns {Module}  mod
 */
function parseId(id, system) {
  const parts = id.split('/')
  let name = parts.shift()

  if (name.charAt(0) === '@') {
    name += '/' + parts.shift()
  }

  if (name in system.modules) {
    const version = semver.valid(parts[0]) ? parts.shift() : ''

    return {
      name: name,
      version: version,
      entry: parts.join('/')
    }
  }
  else {
    return { name: id }
  }
}


/**
 * Factory
 *
 * @param {Object}           opts
 * @param {string|string[]} [opts.cacheExcept=[]]         Cache exceptions
 * @param {boolean}         [opts.cachePersist=false]     Don't clear cache every time
 * @param {DependenciesMap} [opts.dependenciesMap=null]   Dependencies map
 * @param {string}          [opts.dest=public]            Cache destination
 * @param {boolean}         [opts.express=false]          Express middleware
 * @param {Object}          [opts.loaderConfig={}]        Loader config
 * @param {string|string[]} [opts.paths=components]       Base directory name or path
 * @param {string}          [opts.root=process.cwd()]     Override current working directory
 * @param {boolean}         [opts.serveSelf=false]        Include host module itself
 * @param {boolean}         [opts.serveSource=false]      Serve sources for devtools
 *
 * @returns {Function|GeneratorFunction} A middleware for Koa or Express
 */
function oceanify(opts = {}) {
  const encoding = 'utf8'
  const root = opts.root || process.cwd()
  const dest = path.resolve(root, opts.dest || 'public')
  const cacheExceptions = [].concat(opts.cacheExcept)
  const serveSource = opts.serveSource
  const loaderConfig = opts.loaderConfig || {}
  const paths = [].concat(opts.paths || 'components').map(function(dir) {
    return path.resolve(root, dir)
  })

  const cache = new Cache({
    dest: dest,
    encoding: encoding
  })

  if (!opts.cachePersist) {
    co(cache.removeAll()).then(function() {
      debug('Cache %s cleared', dest)
    })
  }

  if (cacheExceptions.length) debug('Cache exceptions %s', cacheExceptions)
  if (serveSource) debug('Serving source files.')

  let dependenciesMap
  let system
  let pkg

  let parseSystemPromise = co(function* () {
    dependenciesMap = opts.dependenciesMap || (yield* parseMap(opts))
    system = parseSystem(dependenciesMap)
    pkg = JSON.parse(yield readFile(path.join(root, 'package.json'), 'utf8'))
    Object.assign(loaderConfig, system)
  })

  function mightCacheModule(mod) {
    if (mod.name === pkg.name ||
        cacheExceptions[0] === '*' ||
        cacheExceptions.indexOf(mod.name) >= 0) {
      return
    }

    cache.precompile(mod, {
      dependenciesMap: dependenciesMap,
      system: system
    })
  }

  function* formatMain(id, content) {
    return `${loaderSource}
oceanify.config(${JSON.stringify(loaderConfig)})
${content}
oceanify["import"](${JSON.stringify(id.replace(RE_EXT, ''))})
`
  }

  function* readModule(id, isMain) {
    if (!system) yield parseSystemPromise

    const mod = parseId(id, system)
    const fpath = mod.name in system.modules
      ? findModule(mod, dependenciesMap)
      : yield* findComponent(mod.name, paths)

    if (!fpath) return
    if (mod.name in system.modules) mightCacheModule(mod)

    let content = yield readFile(fpath, encoding)
    const stats = yield lstat(fpath)

    const dependencies = matchRequire.findAll(content)
    content = (opts.serveSelf && !(mod.name in system.modules)
      ? defineComponent
      : define
    )(id.replace(RE_EXT, ''), dependencies, content)

    if (isMain) {
      content = yield* formatMain(id, content)
    }

    return [content, {
      'Cache-Control': 'max-age=0',
      'Content-Type': 'application/javascript',
      ETag: crypto.createHash('md5').update(content).digest('hex'),
      'Last-Modified': stats.mtime.toJSON()
    }]
  }

  /**
   * process components if opts.serveSelf is on
   *
   * @param  {string}   id           component id
   * @param  {string[]} dependencies component dependencies
   * @param  {string}   factory      component factory
   * @return {string}                wrapped component declaration
   */
  function defineComponent(id, dependencies, factory) {
    const base = paths[0]

    for (let i = 0; i < dependencies.length; i++) {
      const dep = dependencies[i]
      const fpath = path.resolve(base, dep)

      if (dep.indexOf('..') === 0 &&
          fpath.indexOf(base) < 0 &&
          fpath.indexOf(root) === 0) {
        const depAlias = fpath.replace(root, pkg.name)
        dependencies[i] = depAlias
        factory = matchRequire.replaceAll(factory, function(match, quote, name) {
          return name === dep
            ? ['require(', depAlias, ')'].join(quote)
            : match
        })
      }
    }

    return define(id, dependencies, factory)
  }


  const importer = postcss().use(atImport({ path: [root] }))
  const prefixer = postcss().use(autoprefixer())

  function* readStyle(id) {
    const destPath = path.join(dest, id)
    const fpath = (yield* findComponent(id, paths)) ||
      path.join(root, 'node_modules', id)

    if (!(yield exists(fpath))) return

    const source = yield readFile(fpath, encoding)
    const processOpts = {
      from: path.relative(root, fpath),
      to: path.relative(root, destPath),
      map: { inline: false }
    }
    const result = yield importer.process(source, processOpts)
    let content = yield* cache.read(id, result.css)

    if (!content) {
      processOpts.map.prev = result.map
      const resultWithPrefix = yield prefixer.process(result.css, processOpts)

      yield [
        cache.write(id, result.css, resultWithPrefix.css),
        cache.writeFile(id + '.map', resultWithPrefix.map)
      ]
      content = resultWithPrefix.css
    }

    return [content, {
      'Last-Modified': (yield lstat(fpath)).mtime.toJSON()
    }]
  }


  function isSource(id) {
    const fpath = path.join(root, id)
    return id.indexOf('node_modules') === 0 || paths.some(function(base) {
      return fpath.indexOf(base) === 0
    })
  }


  function* readSource(id) {
    const fpath = path.join(root, id)

    if (yield exists(fpath)) {
      const [ content, stats ] = yield [
        readFile(fpath, encoding), lstat(fpath)
      ]

      return [content, {
        'Last-Modified': stats.mtime.toJSON()
      }]
    }
  }


  function* readAsset(id, isMain) {
    const ext = path.extname(id)
    const fpath = yield* findComponent(id, paths)
    let result = null

    if (id === 'loader.js') {
      result = [loaderSource, {
        'Last-Modified': loaderStats.mtime.toJSON()
      }]
    }
    else if (id === 'dependenciesMap.json') {
      yield parseSystemPromise
      result = [JSON.stringify(dependenciesMap, function(key, value) {
        return key === 'dir' ? undefined : value
      }), {
        'Last-Modified': loaderStats.mtime.toJSON()
      }]
    }
    else if (serveSource && isSource(id)) {
      result = yield* readSource(id)
    }
    else if (ext === '.js') {
      result = yield* readModule(id, isMain)
    }
    else if (ext === '.css') {
      result = yield* readStyle(id, isMain)
    }
    else if (RE_ASSET_EXT.test(ext) && fpath) {
      const content = yield readFile(fpath)
      const stats = yield lstat(fpath)

      result = [content, {
        'Last-Modified': stats.mtime.toJSON()
      }]
    }

    if (result) {
      Object.assign(result[1], {
        'Cache-Control': 'max-age=0',
        'Content-Type': mime.lookup(ext),
        ETag: crypto.createHash('md5').update(result[0]).digest('hex')
      })
    }

    return result
  }


  if (opts.express) {
    return function(req, res, next) {
      if (res.headerSent) return next()

      const id = req.path.slice(1)
      const isMain = 'main' in req.query

      co(readAsset(id, isMain)).then(function(result) {
        if (result) {
          res.statusCode = 200
          res.set(result[1])
          if (req.fresh) {
            res.statusCode = 304
          } else {
            res.write(result[0])
          }
          res.end()
        }
        else {
          next()
        }
      }).catch(next)
    }
  }
  else {
    return function* (next) {
      if (this.headerSent) return yield next

      const id = this.path.slice(1)
      const isMain = 'main' in this.query
      const result = yield* readAsset(id, isMain)

      if (result) {
        this.status = 200
        this.set(result[1])
        if (this.fresh) {
          this.status = 304
        } else {
          this.body = result[0]
        }
      }
      else {
        yield next
      }
    }
  }
}


oceanify.parseMap = parseMap
oceanify.compileAll = compileAll.compileAll
oceanify.compileComponent = compileAll.compileComponent
oceanify.compileModule = compileAll.compileModule
oceanify.compileStyleSheets = compileStyleSheets


module.exports = oceanify
