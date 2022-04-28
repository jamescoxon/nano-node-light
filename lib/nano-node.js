import EventEmitter from 'events'
import crypto from 'crypto'
import net from 'net'
import debug from 'debug'

import {
  constants,
  ed25519,
  encodeAddress,
  decodeConnectionInfo
} from '#common'

import NanoSocket from './nano-socket.js'

const log = debug('node')

class NanoRepresentative {
  constructor(account) {
    this.account = account
    this.votes = 0
    this.last_vote = null
  }
}

class NanoPeer {
  constructor({ peerAddress, nanoSocket }) {
    this.nodeId = null
    this.address = peerAddress
    this.messages = 0
    this.last_message = null
    this.nanoSocket = nanoSocket
    this.telemetry = null
    this.last_telemetry_req = null
  }
}

const defaultConfig = {
  discover: true,
  requestTelemetry: false,
  maxPeers: Infinity
}

export default class NanoNode extends EventEmitter {
  constructor({ network = constants.NETWORK.BETA, ...config } = {}) {
    super()

    this.network = network
    this.config = Object.assign(defaultConfig, config)

    const NodeSecret = crypto.randomBytes(32)
    const NodePublic = ed25519.getPublicKey(NodeSecret)
    this.nodeKey = {
      secret: NodeSecret,
      public: NodePublic
    }
    this.NodeID = encodeAddress({ publicKey: NodePublic, prefix: 'node_' })

    log(`Node Secret: ${NodeSecret.toString('hex')}`)
    log(`Node Public: ${Buffer.from(NodePublic).toString('hex')}`)
    log(`Node ID: ${this.NodeID}`)

    this.peers = new Map()
    this.representatives = new Map()

    if (this.config.requestTelemetry) {
      setInterval(
        this.telemetryLoop.bind(this),
        // convert nanoseconds to milliseconds
        network.TELEMETRY_CACHE_CUTOFF / 1e6
      )
    }
  }

  telemetryLoop() {
    for (const peer of this.peers.values()) {
      peer.last_telemetry_req = process.hrtime.bigint()
      peer.nanoSocket.sendMessage({
        messageType: constants.MESSAGE_TYPE.TELEMETRY_REQ,
        message: Buffer.from([]),
        extensions: 0
      })
    }
  }

  _getRepresentative({ account, peerAddress }) {
    const foundRep = this.representatives.get(account)
    if (foundRep) {
      return foundRep
    }

    log(`found new representative ${account}, at ${peerAddress}`)
    const rep = new NanoRepresentative(account)
    this.representatives.set(account, rep)
    return rep
  }

  onPeers(peers) {
    for (const peer of peers) {
      const { address, port } = decodeConnectionInfo(peer)
      if (this.peers.has(`${address}:${peer}`)) continue
      if (this.config.discover && this.peers.size < this.config.maxPeers) {
        this.connect({ address, port })
      }
    }
  }

  onVote({ vote, peerAddress }) {
    const repAddress = vote.account.toString('hex')
    const representative = this._getRepresentative({
      account: repAddress,
      peerAddress
    })

    if (vote.isValid) {
      representative.votes += 1
      representative.last_vote = process.hrtime.bigint()
    } else {
      log(`invalid vote received from ${peerAddress}, rep: ${repAddress}`)
    }
  }

  publish(block, peerCount = 8) {
    const shuffled = Array.from(this.peers.values())
      .map((value) => ({ value, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .map(({ value }) => value)
    const size = Math.max(peerCount, shuffled.length)
    const selected = shuffled.slice(0, size)

    for (const peer of selected) {
      peer.nanoSocket.sendMessage({
        messageType: constants.MESSAGE_TYPE.PUBLISH,
        message: block,
        extensions: 0x600
      })
    }
  }

  onTelemetry({ telemetry, peerAddress }) {
    const result = {
      isPeer: true,
      isRejected: false,
      isLate: false,
      isUnsolicited: false
    }

    const peer = this.peers.get(peerAddress)
    const telemetryNodeId = encodeAddress({
      publicKey: telemetry.node_id,
      prefix: 'node_'
    })

    if (!telemetryNodeId === peer.nanoSocket.connectedNodeId) {
      result.isRejected = true
      result.isPeer = false
      log(`mismatched telemetry & socket node_id (${peerAddress})`)
    }

    if (!peer.last_telemetry_req) {
      result.isRejected = true
      result.isUnsolicited = true
      log(`unsolicited telemetry_ack (${peerAddress})`)
    } else if (process.hrtime.bigint() - peer.last_telemetry_req > 1e10) {
      result.isRejected = true
      result.isLate = true
      log(`late telemetry_ack (${peerAddress})`)
    }

    this.emit('telemetry', { ...telemetry, ...result })

    if (result.isRejected) {
      return
    }

    peer.telemetry = telemetry
    peer.last_telemetry_req = null
  }

  onConnection = (socket) => {
    const nanoSocket = new NanoSocket({ socket, node: this })
    this.setupNanoSocket(nanoSocket)
  }

  listen({ address = '::0', port = this.network.PORT }) {
    this.server = net.createServer(null, this.onConnection)
    this.server.listen(port, address, () => {
      log(`Node Address: ${address}:${port}`)
      this.emit('listening')
    })
  }

  connect({ address, port }) {
    const peerAddress = `${address}:${port}`
    log(`opening connection to ${peerAddress} (current: ${this.peers.size})`)
    const nanoSocket = new NanoSocket({
      address,
      port,
      node: this
    })
    this.setupNanoSocket(nanoSocket)
  }

  setupNanoSocket = (nanoSocket) => {
    const { peerAddress } = nanoSocket
    const peer = new NanoPeer({ peerAddress, nanoSocket })

    nanoSocket.on('error', (error) => {
      this.emit('error', error)
    })

    nanoSocket.on('handshake', ({ nodeId }) => {
      this.emit('handshake', {
        nodeId,
        peerAddress
      })
    })

    nanoSocket.on('message', (message) => {
      peer.messages += 1
      this.emit('message', message)
    })

    nanoSocket.on('peers', (peers) => {
      this.onPeers(peers)
    })

    nanoSocket.on('vote', (vote) => {
      this.emit('vote', vote)
      this.onVote({ vote, peerAddress })
    })

    nanoSocket.on('telemetry', (telemetry) => {
      this.onTelemetry({ telemetry, peerAddress })
    })

    nanoSocket.on('represenative', (representative) => {})

    nanoSocket.on('close', () => {
      this.peers.delete(peerAddress)
      log(`closed connection to ${peerAddress} (current: ${this.peers.size})`)
    })

    this.peers.set(peerAddress, peer)
  }
}

export { constants as NanoConstants }
