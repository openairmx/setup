class Device {
  #deviceName
  #primaryServiceUuid
  #writeCharacteristicUuid
  #notifyCharacteristicUuid

  constructor(deviceName, primaryServiceUuid, writeCharacteristicUuid, notifyCharacteristicUuid) {
    this.#deviceName = deviceName
    this.#primaryServiceUuid = primaryServiceUuid
    this.#writeCharacteristicUuid = writeCharacteristicUuid
    this.#notifyCharacteristicUuid = notifyCharacteristicUuid
  }

  static airmxPro() {
    return new Device(
      'AIRMX Pro',
      '22210000-554a-4546-5542-46534450464d',
      '22210001-554a-4546-5542-46534450464d',
      '22210002-554a-4546-5542-46534450464d'
    )
  }

  get name() {
    return this.#deviceName
  }

  get primaryServiceUuid() {
    return this.#primaryServiceUuid
  }

  get writeCharacteristicUuid() {
    return this.#writeCharacteristicUuid
  }

  get notifyCharacteristicUuid() {
    return this.#notifyCharacteristicUuid
  }
}

class Dispatcher {
  #characteristic
  #sequenceNumber = 1
  #chunkSize = 16

  constructor(characteristic) {
    this.#characteristic = characteristic
  }

  async dispatch(command) {
    const data = this.#chunk(command.payload, command)

    for (let chunk of data) {
      console.log(`Sending chunk: ${Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)
      await this.#characteristic.writeValueWithResponse(chunk)
      await delay(500)
    }
  }

  #chunk(data, command) {
    const packets = this.#chunked(data, this.#chunkSize)
    const total = packets.length

    if (total === 0) {
      return [
        this.#packetHeader(
          this.#sequenceNumber++, 1, 1, // 1 of 1 packet
          command.commandId
        )
      ]
    }

    return packets.map((chunk, index) => {
      return new Uint8Array([
        ...this.#packetHeader(
          this.#sequenceNumber++, index + 1, total,
          command.commandId
        ),
        ...chunk
      ])
    })
  }

  /**
   * Splits an array into chunks of `size`.
   *
   * @param {Uint8Array} data - The array of 8-bit unsigned integers.
   * @param {number} size - The size of each chunk.
   */
  #chunked(data, size) {
    const packets = []

    for (let i = 0; i < data.length; i += size) {
      packets.push(data.slice(i, i + size))
    }

    return packets
  }

  #packetHeader(sequenceNumber, currentPacket, totalPacket, commandId) {
    return new Uint8Array([
      sequenceNumber,
      currentPacket << 4 | totalPacket,
      0x00, // Unencrypted flag
      commandId
    ])
  }
}

class BluetoothHandler {
  #device
  #dispatcher = null
  #gatt = null
  #writeCharacteristic = null
  #notifyCharacteristic = null
  #notificationHandler = null

  /**
   * @param {Device} device
   */
  constructor(device) {
    this.#device = device
  }

  async connect() {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ name: this.#device.name }],
      optionalServices: [this.#device.primaryServiceUuid]
    })

    this.#gatt = await device.gatt.connect()
    const service = await this.#gatt.getPrimaryService(this.#device.primaryServiceUuid)
    this.#writeCharacteristic = await service.getCharacteristic(this.#device.writeCharacteristicUuid)
    this.#notifyCharacteristic = await service.getCharacteristic(this.#device.notifyCharacteristicUuid)
    this.#dispatcher = new Dispatcher(this.#writeCharacteristic)

    await this.#notifyCharacteristic.startNotifications()
    this.#notifyCharacteristic.addEventListener('characteristicvaluechanged', this.#handleNotification.bind(this))
  }

  async disconnect() {
    if (this.#notifyCharacteristic) {
      await this.#notifyCharacteristic.stopNotifications()
      this.#notifyCharacteristic.removeEventListener('characteristicvaluechanged', this.#handleNotification.bind(this))
      this.#notifyCharacteristic = null
    }

    this.#dispatcher = null
    this.#writeCharacteristic = null

    if (this.#gatt) {
      this.#gatt.disconnect()
      this.#gatt = null
    }
  }

  /**
   * @param {Command} command - The command to dispatch.
   */
  async dispatch(command) {
    if (! this.#dispatcher) {
      return
    }
    await this.#dispatcher.dispatch(command)
    return this
  }

  onNotification(handler) {
    this.#notificationHandler = handler
    return this
  }

  #handleNotification(event) {
    if (this.#notificationHandler) {
      this.#notificationHandler(event)
    }
  }
}

class Command {
  get commandId() {
    throw new Error('The command ID does not exist.')
  }

  get payload() {
    throw new Error('The payload does not exist.')
  }
}

class HandshakeCommand extends Command {
  get commandId() {
    return 0x0b
  }

  get payload() {
    return new Uint8Array([
      0x08, // The storage size of the token
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Token: 0
      0x05, // The length of the version
      0x31, 0x2e, 0x30, 0x2e, 0x30 // Version: 1.0.0
    ])
  }
}

class ConfigureWifiCommand extends Command {
  #ssid
  #password

  constructor(ssid, password) {
    super()
    this.#ssid = ssid
    this.#password = password
  }

  get commandId() {
    return 0x15
  }

  get payload() {
    const encoder = new TextEncoder()
    const ssid = encoder.encode(this.#ssid)
    const password = encoder.encode(this.#password)

    return new Uint8Array([
      ssid.length, ...ssid,
      password.length, ...password
    ])
  }
}

class RequestIdentityCommand extends Command {
  get commandId() {
    return 0x16
  }

  get payload() {
    return new Uint8Array([
      //
    ])
  }
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class IncomingMessageHandler {
  #encoder
  #bag = []
  #messageHandler = null

  constructor() {
    this.#encoder = new TextEncoder()
  }

  handle(packet) {
    const message = IncomingMessage.parse(this.#encoder.encode(packet))
    this.#addToBag(message)
  }

  onMessage(handler) {
    this.#messageHandler = handler
    return this
  }

  /**
   * @param {IncomingMessage} message
   */
  #addToBag(message) {
    this.#bag.push(message)

    if (message.currentPacket === message.totalPacket) {
      this.#processBag()
    }
  }

  #processBag() {
    const bag = [...this.#bag]
    const lastMessage = bag.at(-1)

    if (bag.length !== lastMessage.totalPacket) {
      throw new Error('Incomplete message received.')
    }

    const data = []

    for (const [index, message] of bag.entries()) {
      if (message.currentPacket !== index + 1) {
        throw new Error(`Message packet ${index + 1} is missing.`)
      }

      data.push(...message.payload)
    }

    const completeMessage = new CompleteMessage(
      lastMessage.commandId, new Uint8Array(data)
    )

    this.#notify(completeMessage)
    this.#clearBag()
  }

  #clearBag() {
    this.#bag = []
  }

  /**
   * @param {CompleteMessage} message
   */
  #notify(message) {
    if (this.#messageHandler) {
      this.#messageHandler(message)
    }
  }
}

class IncomingMessage {
  /**
   * @param {number} sequenceNumber - The sequence number of the packet.
   * @param {number} currentPacket - The current packet number.
   * @param {number} totalPacket - The total number of packets.
   * @param {boolean} encrypted - Determines if the packet is encrypted.
   * @param {number} commandId - The command ID.
   * @param {Uint8Array} payload - The message payload.
   */
  constructor(sequenceNumber, currentPacket, totalPacket, encrypted, commandId, payload) {
    this.sequenceNumber = sequenceNumber
    this.currentPacket = currentPacket
    this.totalPacket = totalPacket
    this.encrypted = encrypted
    this.commandId = commandId
    this.payload = payload
  }

  /**
   * @param {Uint8Array} packet - The raw packet data.
   * @returns {IncomingMessage}
   */
  static parse(packet) {
    if (packet.length < 4) {
      throw new Error('Invalid packet length.')
    }

    const sequenceNumber = packet[0]
    const currentPacket = packet[1] >> 4
    const totalPacket = packet[1] & 0x0f
    const encrypted = packet[2]
    const commandId = packet[3]

    return new IncomingMessage(
      sequenceNumber, currentPacket, totalPacket,
      !! encrypted, commandId, packet.slice(4)
    )
  }
}

class CompleteMessage {
  /**
   * @param {number} commandId - The command ID of the message.
   * @param {Uint8Array} payload - The message payload.
   */
  constructor(commandId, payload) {
    this.commandId = commandId
    this.payload = payload
  }
}

class Form {
  #activeClassName = 'form--active'

  constructor(id) {
    this.form = document.getElementById(id)
    if (this.form === null) {
      throw new Error(`Form with id ${id} does not exist.`)
    }
  }

  display() {
    this.form.classList.add(this.#activeClassName)

    if (typeof this.onDisplay === 'function') {
      this.onDisplay()
    }
  }

  hide() {
    this.form.classList.remove(this.#activeClassName)

    if (typeof this.onHide === 'function') {
      this.onHide()
    }
  }
}

class ProgressibleForm extends Form {
  #nextForm = null

  nextTo(form) {
    this.#nextForm = form
    return this
  }

  transitToNextForm() {
    if (this.#nextForm === null) {
      return
    }

    this.hide()
    this.#nextForm.display()
  }
}

class WelcomeForm extends ProgressibleForm {
  constructor(id) {
    super(id)
    this.form.addEventListener('submit', this.handleSubmit.bind(this))
  }

  handleSubmit(event) {
    event.preventDefault()
    this.transitToNextForm()
  }
}

class WifiCredentialsForm extends ProgressibleForm {
  #submitCallback = null

  constructor(id) {
    super(id)
    this.form.addEventListener('submit', this.handleSubmit.bind(this))
  }

  handleSubmit(event) {
    event.preventDefault()
    const { elements } = event.target
    try {
      const [ssid, password] = this.validate(elements.ssid.value, elements.password.value)
      if (this.#submitCallback) {
        this.#submitCallback({ ssid, password })
      }
      this.transitToNextForm()
    } catch (error) {
      this.alert(error.message)
    }
  }

  validate(ssid, password) {
    if (ssid === '' ) {
      throw new Error('SSID cannot be empty.')
    }

    if (ssid.length > 32) {
      throw new Error('SSID cannot be longer than 32 characters.')
    }

    if (password === '' ) {
      throw new Error('Password cannot be empty.')
    }

    if (password.length < 8 || password.length > 63) {
      throw new Error('Password must be between 8 and 63 characters long.')
    }

    return [ssid, password]
  }

  alert(message) {
    this.form.querySelector('.help-text')?.remove()

    const element = document.createElement('div')
    element.classList.add('help-text', 'help-text--danger')
    element.textContent = message

    this.form.querySelector('.form__footer').before(element)
  }

  onSubmit(callback) {
    this.#submitCallback = callback
    return this
  }
}

class PairingActivationForm extends ProgressibleForm {
  constructor(id) {
    super(id)
    this.form.addEventListener('submit', this.handleSubmit.bind(this))
  }

  handleSubmit(event) {
    event.preventDefault()
    this.transitToNextForm()
  }
}

class CommunicationForm extends Form {
  #handler
  #messages = null

  #handshakeCommand
  #wifiCredentialsCommand
  #identityCommand

  #successForm = null
  #failureForm = null

  #retryMessage = null
  #retryMessageClassName = 'retry-message'
  #retryMessageShownClassName = 'retry-message--shown'

  #retryLink = null
  #retryLinkClassName = `retry-link`

  /**
   * @param {string} id - The ID of the form.
   * @param {BluetoothHandler} handler - The Bluetooth handler to manage the connection.
   */
  constructor(id, handler) {
    super(id)
    this.#handler = handler
    this.#handler.onNotification((event) => {
      this.#messages.handle(event.target.value)
    })
    this.#messages = new IncomingMessageHandler()
    this.#messages.onMessage(this.handleMessage.bind(this))
    this.#handshakeCommand = new HandshakeCommand()
    this.#wifiCredentialsCommand = new ConfigureWifiCommand('', '')
    this.#identityCommand = new RequestIdentityCommand()
    this.#retryMessage = this.form.querySelector(`.${this.#retryMessageClassName}`)
    if (this.#retryMessage) {
      this.#retryLink = this.form.querySelector(`.${this.#retryLinkClassName}`)
      this.#retryLink.addEventListener('click', () => {
        this.hideRetryOption()
        this.startPairing()
      })
    }
  }

  onDisplay() {
    this.startPairing()
  }

  async startPairing() {
    try {
      await this.connect()
    } catch {
      this.showRetryOption()
    } finally {
      this.disconnectIfNeeded()
    }
  }

  async connect() {
    if (! this.#handler) {
      return
    }
    await this.#handler.connect()
    await this.#handler.dispatch(this.#handshakeCommand)
  }

  async disconnectIfNeeded() {
    await this.#handler.disconnect()
  }

  /**
   * @param {CompleteMessage} message
   */
  handleMessage(message) {
    switch (message.commandId) {
      case this.#handshakeCommand.commandId:
        this.handleHandshakeMessage(message)
        break
      case this.#wifiCredentialsCommand.commandId:
        this.handleWifiCredentialsMessage(message)
        break
      case this.#identityCommand.commandId:
        this.handleIdentityMessage(message)
        break
      default:
        console.warn(`Unknown command ID: ${message.commandId}`)
        break
    }
  }

  /**
   * @param {CompleteMessage} message
   */
  handleHandshakeMessage(message) {
    this.#handler.dispatch(this.#wifiCredentialsCommand)
  }

  /**
   * @param {CompleteMessage} message
   */
  handleWifiCredentialsMessage(message) {
    this.#handler.dispatch(this.#identityCommand)
  }

  /**
   * @param {CompleteMessage} message
   */
  handleIdentityMessage(message) {
    this.transitToSuccessResultForm()
  }

  showRetryOption() {
    if (this.#retryMessage === null) {
      return
    }

    this.#retryMessage.classList.add(this.#retryMessageShownClassName)
  }

  hideRetryOption() {
    if (this.#retryMessage === null) {
      return
    }

    this.#retryMessage.classList.remove(this.#retryMessageShownClassName)
  }

  succeedTo(form) {
    this.#successForm = form
    return this
  }

  failTo(form) {
    this.#failureForm = form
    return this
  }

  wifiCredentialsUsing(credentials) {
    this.#wifiCredentialsCommand = new ConfigureWifiCommand(credentials.ssid, credentials.password)
    return this
  }

  transitToSuccessResultForm() {
    this.hide()
    this.#successForm?.display()
  }

  transitToFailureResultForm() {
    this.hide()
    this.#failureForm?.display()
  }
}

class Application {
  static supportBluetoothApi() {
    return 'bluetooth' in navigator
  }

  static run() {
    if (! this.supportBluetoothApi()) {
      const unsupportedForm = new Form('form-unsupported')
      unsupportedForm.display()
      return
    }

    const handler = new BluetoothHandler(Device.airmxPro())

    const successForm = new Form('form-result-success')
    const failureForm = new Form('form-result-failure')
    const communicationForm = new CommunicationForm('form-communication', handler)
      .succeedTo(successForm)
      .failTo(failureForm)
    const pairingActivationForm = new PairingActivationForm('form-pairing-activation')
      .nextTo(communicationForm)
    const wifiCredentialsForm = new WifiCredentialsForm('form-wifi-credentials')
      .nextTo(pairingActivationForm)
      .onSubmit((credentials) => {
        communicationForm.wifiCredentialsUsing(credentials)
      })
    const welcomeForm = new WelcomeForm('form-welcome')
      .nextTo(wifiCredentialsForm)

    welcomeForm.display()
  }
}

Application.run()
