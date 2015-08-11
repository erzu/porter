'use strict'

var path = require('path')
var fs = require('fs')
var co = require('co')
var semver = require('semver')
var matchRequire = require('match-require')

var parseMap = require('./lib/parseMap')
var flattenMap = require('./lib/flattenMap')
var define = require('./lib/define')


function readFile(fpath, encoding) {
  return new Promise(function(resolve, reject) {
    fs.readFile(fpath, encoding, function(err, content) {
      if (err) reject(err)
      else resolve(content)
    })
  })
}


/*
 * Find the path of a module in the dependencies map.
 */
function findModule(mod, dependenciesMap) {
  var props = []

  function walk(map) {
    var name = mod.name

    if (name in map && map[name].version === mod.version) {
      return path.join(map[name].dir, mod.entry)
    }

    for (name in map) {
      props.push(name)
      var result = walk(map[name].dependencies)
      if (result) return result
      props.pop()
    }
  }

  return walk(dependenciesMap)
}


function parseId(id, system) {
  var parts = id.split('/')
  var name = parts.shift()

  if (name.charAt(0) === '@') {
    name += '/' + parts.shift()
  }

  if (name in system.modules) {
    var version = semver.valid(parts[0]) ? parts.shift() : ''

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


/*
 * Factory
 */
function oceanify(opts) {
  opts = opts || {}
  var encoding = 'utf-8'
  var cwd = opts.cwd || process.cwd()
  var base = path.resolve(cwd, opts.base || 'components')

  var dependenciesMap
  var system

  var parseLocal = co.wrap(function* (result) {
    if (!opts.local) return result

    var content = yield readFile(path.join(cwd, 'package.json'), encoding)
    var pkg = JSON.parse(content)

    result[pkg.name] = {
      dir: cwd,
      version: pkg.version,
      main: pkg.main || 'index'
    }

    return result
  })


  return function(req, res, next) {
    if (!req.path) {
      Object.defineProperty(req, 'path', {
        get: function() {
          return this.url.split('?')[0]
        }
      })
    }

    if (path.extname(req.path) !== '.js') {
      return next()
    }

    if (req.path === '/import.js') {
      return sendFile('import.js')
    }

    var id = req.path.slice(1).replace(/\.js$/, '')

    function sendComponent(err, factory) {
      if (err) {
        return err.code === 'ENOENT' ? send404() : next(err)
      }

      var body = define(id, matchRequire.findAll(factory), factory)

      if (/^(?:app|runner|main)\b/.test(id)) {
        body = [
          define('system', [], 'module.exports = ' + JSON.stringify(system)),
          body
        ].join('\n')
      }

      sendContent(body)
    }

    function sendFile(fname) {
      var fpath = path.join(__dirname, fname)

      fs.readFile(fpath, encoding, function(err, content) {
        if (err) next(err)
        else sendContent(content)
      })
    }

    function sendContent(content) {
      if (res.is) {
        res.status = 200
        res.type = 'application/javascript'
        res.body = content
        next()
      }
      else {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/javascript')
        res.write(content, encoding)
        res.end()
      }
    }

    function send404() {
      if (res.is) {
        res.status = 404
        next()
      }
      else {
        res.statusCode = 404
        res.end()
      }
    }

    function main() {
      var mod = parseId(id, system)
      var fpath

      fpath = mod.name in system.modules
        ? findModule(mod, dependenciesMap)
        : path.join(base, mod.name)

      if (fpath) {
        fs.readFile(fpath + '.js', encoding, sendComponent)
      } else {
        send404()
      }
    }

    if (system) {
      main()
    } else {
      parseMap(opts).then(parseLocal).then(function(result) {
        dependenciesMap = result
        system = flattenMap(result)
        main()
      }, next)
    }
  }
}


var compileAll = require('./lib/compileAll')

oceanify.parseMap = parseMap
oceanify.compileAll = compileAll.compileAll
oceanify.compileComponent = compileAll.compileComponent
oceanify.compileModule = compileAll.compileModule


// Expose oceanify
module.exports = oceanify
