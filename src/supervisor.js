'use strict'

/**
 * dsh web 服务的进程管理：查找 dsh、拉起服务、解析它打印的带 token 地址、优雅关停。
 *
 * 这一段是纯 Node（不依赖 Electron），因此可以用 `npm run smoke` 在无图形环境下自检。
 */

const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** dsh web 就绪时打印的一行：`dsh web: http://127.0.0.1:<port>/?token=...` */
const READY_PATTERN = /dsh web:\s+(http:\/\/\S+)/
const MAX_TAIL_LINES = 40

function isExecutable(file) {
  if (!file) return false
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function realPathOrSelf(file) {
  try {
    return fs.realpathSync(file)
  } catch {
    return file
  }
}

/**
 * 按 DSH_BIN → PATH → ~/.local/opt/node-* /bin → ~/.local/bin 的顺序找 dsh。
 * @param {object} [options] `exclude` 列出的路径（含其真实路径）会被跳过，用于避开自身符号链接。
 */
function findDsh(env = process.env, options = {}) {
  const candidates = []
  if (env.DSH_BIN) candidates.push(env.DSH_BIN)
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'dsh'))
  }
  const home = env.HOME || os.homedir()
  const optDir = path.join(home, '.local', 'opt')
  let entries = []
  try {
    entries = fs.readdirSync(optDir)
  } catch {
    entries = []
  }
  for (const entry of entries.sort().reverse()) {
    if (entry.startsWith('node-')) candidates.push(path.join(optDir, entry, 'bin', 'dsh'))
  }
  candidates.push(path.join(home, '.local', 'bin', 'dsh'))
  const blocked = (options.exclude || []).map(realPathOrSelf)
  return (
    candidates.find((candidate) => isExecutable(candidate) && !blocked.includes(realPathOrSelf(candidate))) || null
  )
}

/** 从一行输出里取出带 token 的地址；不是那一行就返回 null。 */
function parseReadyLine(line) {
  const match = READY_PATTERN.exec(line)
  return match ? match[1] : null
}

class DshServer extends EventEmitter {
  constructor({ dshPath = findDsh(), cwd = os.homedir(), port = 0, logFile = null } = {}) {
    super()
    this.dshPath = dshPath
    this.cwd = cwd
    this.port = port
    this.logFile = logFile
    this.child = null
    this.url = null
    this.tail = []
    this.logStream = null
  }

  get running() {
    return this.child !== null
  }

  /** 最近的输出尾部，用于把失败原因带进诊断报告。 */
  get tailText() {
    return this.tail.join('\n')
  }

  _openLog() {
    if (!this.logFile) return
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true, mode: 0o700 })
      if (fs.existsSync(this.logFile)) fs.renameSync(this.logFile, `${this.logFile}.1`)
      this.logStream = fs.createWriteStream(this.logFile, { flags: 'a', mode: 0o600 })
    } catch {
      this.logStream = null
    }
  }

  _closeLog() {
    if (!this.logStream) return
    try {
      this.logStream.end()
    } catch {
      /* 忽略 */
    }
    this.logStream = null
  }

  _record(line) {
    this.tail.push(line)
    if (this.tail.length > MAX_TAIL_LINES) this.tail.shift()
    if (this.logStream) {
      try {
        this.logStream.write(`${line}\n`)
      } catch {
        /* 忽略 */
      }
    }
    this.emit('log', line)
  }

  _kill(signal = 'SIGTERM') {
    if (!this.child) return
    try {
      this.child.kill(signal)
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 启动 `dsh web --no-open --port <port>`，并解析它打印的就绪地址。
   * @returns {Promise<{url: string, port: number, pid: number}>}
   */
  start(timeoutMs = 60000) {
    if (this.child) return Promise.reject(new Error('dsh 服务已在运行'))
    if (!isExecutable(this.dshPath)) {
      return Promise.reject(
        new Error('找不到 dsh 命令：请先运行 `npm i -g @deepseek-ai/dsh`，或用 DSH_BIN 指定路径'),
      )
    }

    this._openLog()
    const child = spawn(this.dshPath, ['web', '--no-open', '--port', String(this.port)], {
      cwd: this.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.url = null
    this.tail = []

    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        settle(
          reject,
          new Error(`等待 dsh web 就绪超时（${Math.round(timeoutMs / 1000)}s）\n${this.tail.join('\n')}`),
        )
        this._kill()
      }, timeoutMs)

      const settle = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }

      const onLine = (rawLine) => {
        const line = rawLine.replace(/\r$/, '')
        this._record(line)
        const url = parseReadyLine(line)
        if (!url) return
        this.url = url
        settle(resolve, { url, port: Number(new URL(url).port), pid: child.pid })
      }

      const consume = (stream) => {
        let buffer = ''
        stream.setEncoding('utf8')
        stream.on('data', (chunk) => {
          buffer += chunk
          let index
          while ((index = buffer.indexOf('\n')) >= 0) {
            onLine(buffer.slice(0, index))
            buffer = buffer.slice(index + 1)
          }
        })
        stream.on('end', () => {
          if (buffer.trim()) onLine(buffer)
        })
      }
      consume(child.stdout)
      consume(child.stderr)

      child.once('error', (error) => settle(reject, error))
      child.once('exit', (code, signal) => {
        const detail = this.tail.join('\n')
        this.child = null
        this._closeLog()
        settle(reject, new Error(`dsh web 启动失败（exit ${code ?? signal}）\n${detail}`))
        this.emit('exit', { code, signal })
      })
    })
  }

  /** 先 SIGTERM，宽限期内没退出再 SIGKILL。 */
  async stop(graceMs = 8000) {
    const child = this.child
    if (!child) {
      this._closeLog()
      return
    }
    await new Promise((resolve) => {
      let finished = false
      const done = () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 忽略 */
        }
        done()
      }, graceMs)
      child.once('exit', done)
      try {
        child.kill('SIGTERM')
      } catch {
        done()
      }
    })
    this.child = null
    this._closeLog()
  }
}

module.exports = { DshServer, findDsh, parseReadyLine, isExecutable, READY_PATTERN }
