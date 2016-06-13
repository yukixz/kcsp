import http from 'http'
import net from 'net'
import url from 'url'
import zlib from 'zlib'
import request from 'request'
import querystring from 'querystring'
import logger from './logger'
import * as db from './db'

const responseError = {
    403: '<h1>HTTP 403 - Forbidden</h1>参数错误或无访问权限。',
    410: '<h1>HTTP 410 - Gone</h1>获取数据失败。',
    500: '<h1>HTTP 500 - Internal Server Error</h1>服务器内部执行过程中遇到错误。请向webmaster提交错误报告以解决问题。',
    503: '<h1>HTTP 503 - Service Unavailable</h1>暂未获取到数据。请稍后再试。'
}

async function onConnect(req, sock) {
    logger.info(`CONNECT accept: ${req.url}`)

    let urlp = url.parse(`http://${req.url}`)
    let rSock = net.createConnection({
        host: urlp.hostname,
        port: urlp.port || 80,
    })
    rSock.on('connect', () => {
        logger.info(`CONNECT processing: ${req.url}`)
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        sock.pipe(rSock)
        rSock.pipe(sock)
    })
    rSock.on('error', (err) => {
        logger.error([
            `CONNECT error: ${req.url}`,
            `error: ${err}`,
        ].join('\n\t'))
        sock.destroy()
        rSock.destroy()
    })
    sock.on('close', () => rSock.destroy())
    rSock.on('close', () => sock.destroy())
}

async function onRequest(req, res) {
    if (isGameAPI(req)) {
        return onAPIRequest(req, res)
    }

    // Process simple proxy request
    logger.info(`REQUEST accept: ${req.method}, ${req.url}`)
    let urlp = url.parse(req.url)
    let opts = {
        method: req.method,
        protocol: urlp.protocol,
        hostname: urlp.hostname,
        port: urlp.port,
        path: urlp.path,
        headers: removeProxyHeaders(req.headers),
    }

    let rReq = http.request(opts, (rRes) => {
        res.writeHead(rRes.statusCode, removeProxyHeaders(rRes.headers))
        rRes.pipe(res)
    })
    rReq.on('error', (err) => {
        res.socket.destroy()
    })
    rReq.on('error', () => res.socket.destroy())
    req.on('error', () => rReq.socket.destroy())
    req.pipe(rReq)
}

async function onAPIRequest(req, res) {
    let chunks = []
    req.on('data', chunk => {
        chunks.push(chunk)
    })

    req.on('end', async () => {
        logger.info(`API accept: ${req.url}`)
        let stime = Date.now()
        let body = Buffer.concat(chunks)

        try {
            let id = getRequestId(req, body)
            let data = await makeAPIRequest(req, body, id)

            res.writeHead(data.statusCode, data.headers)
            res.end(data.content)
            logger.info(`API response to: ${req.url}`)
        }
        catch(err) {
            let errCode = 500
            switch(err.message) {
                case "unavailable":
                    errCode = 503
                    break
                case "gone":
                    errCode = 410
                    break
                case "forbidden":
                    errCode = 403
                    break
            }
            renderErrorPage(res, errCode)
            logger.error([
                `response ${errCode}: ${req.url}`,
                `error: ${err}`
                ].join('\n\t'))
        }

        logger.info(`API finish: ${req.url}, handled in ${(Date.now() - stime) / 1000}s`)
    })
}

async function makeAPIRequest(req, body, id) {
    logger.info(`API processing: ${req.url}, id ${id}`)

    let locked = await db.get('lock')
    if (locked === 'true') {
        throw new Error('unavailable')
    }

    let data = await db.get(id)
    if (data === '__REQUEST__') {
        throw new Error('unavailable')
    }
    else if (data === '__BLOCK__') {
        throw new Error('gone')
    }
    else if (data != null) {
        try {
            return JSON.parse(data, (key, value) =>
                (value && value.type === 'Buffer') ? new Buffer(value.data) : value)
        }
        catch (err) {
            logger.error([
                    'parse db data error:',
                    `error: ${err}`,
                    `data: ${data}`
                ].join('\n\t'))
            throw new Error('gone')
        }
    }
    else {
        try {
            logger.info(`API requesting: ${req.url}`)
            db.put(id, '__REQUEST__')

            let rr = await makeRequest({
                method:  req.method,
                url:     req.url,
                body:    (body.length > 0) ? body : null,
                headers: removeProxyHeaders(req.headers),
                encoding: null,
                timeout: 180000,
            })
            if (rr.statusCode >= 400) {
                logger.error([
                    `API responsed: ${req.url}, code ${rr.statusCode}`,
                    `body: ${body}`,
                    `headers: ${JSON.stringify(req.headers)}`,
                    `response: ${rr.body}`
                ].join('\n\t'))
            } else {
                logger.info(`API responsed: ${req.url}, code ${rr.statusCode}`)
            }

            let cacheObj = {
                statusCode: rr.statusCode,
                headers:    removeProxyHeaders(rr.headers),
                content:    rr.body,
            }
            db.put(id, JSON.stringify(cacheObj))
            return cacheObj
        }
        catch (err) {
            logger.error([
                `API request error: ${req.url}`,
                `error: ${err}`,
                `body: ${body}`,
                `headers: ${JSON.stringify(req.headers)}`,
            ].join('\n\t'))
            db.put(id, '__BLOCK__')
            throw new Error('gone')
        }
    }
}

function getRequestId(req, body) {
    let bodyp = querystring.parse(body.toString())
    let user  = bodyp.api_token
    let token = req.headers['cache-token']
    if (user != null && token != null) {
        return `${user}-${token}`
    } else {
        throw new Error('forbidden')
    }
}

function isGameAPI(req) {
    let urlp = url.parse(req.url)
    return urlp.pathname.startsWith('/kcsapi/')
}

function makeRequest(opts) {
    return new Promise((resolve, reject) => {
        request(opts, (err, res, body) => {
            if (err) {
                reject(err)
            } else {
                resolve(res)
            }
        })
    })
}

function removeProxyHeaders(origin) {
    let headers = {}
    for (var key in origin) {
        headers[key] = origin[key]
    }
    delete headers['connection']
    delete headers['proxy-connection']
    delete headers['proxy-authenticate']
    delete headers['proxy-authorization']
    delete headers['host']
    delete headers['content-length']
    delete headers['cache-token']
    delete headers['request-uri']
    return headers
}

function renderErrorPage(resp, code) {
    resp.writeHead(code, {'content-type': 'text/html'})
    resp.write('<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>')
    resp.write(responseError[code])
    resp.end('<hr/>Powered by KCSP Server</body></html>')
}


let server = http.createServer()
server.on('connect', onConnect)
server.on('request', onRequest)

export default server
