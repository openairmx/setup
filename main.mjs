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

  /** @type {IncomingMessage[]} */
  #bag = []

  #messageHandler = null

  constructor() {
    this.#encoder = new TextEncoder()
  }

  /**
   * @param {DataView} view
   */
  handle(view) {
    const message = IncomingMessage.parse(view)
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

    let data = new Uint8Array()

    for (const [index, message] of bag.entries()) {
      if (message.currentPacket !== index + 1) {
        throw new Error(`Message packet ${index + 1} is missing.`)
      }

      const temp = new Uint8Array(data.byteLength + message.payload.byteLength)
      temp.set(data)
      temp.set(message.payload, data.byteLength)
      data = temp
    }

    const completeMessage = new CompleteMessage(
      lastMessage.commandId, new DataView(data.buffer)
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
   * @param {DataView} view - The raw packet data.
   * @returns {IncomingMessage}
   */
  static parse(view) {
    if (view.byteLength < 4) {
      throw new Error('Invalid packet length.')
    }

    const sequenceNumber = view.getUint8(0)
    const currentPacket = view.getUint8(1) >> 4
    const totalPacket = view.getUint8(1) & 0x0f
    const encrypted = view.getUint8(2)
    const commandId = view.getUint8(3)

    return new IncomingMessage(
      sequenceNumber, currentPacket, totalPacket,
      !! encrypted, commandId, new Uint8Array(view.buffer.slice(4))
    )
  }
}

class CompleteMessage {
  /**
   * @param {number} commandId - The command ID of the message.
   * @param {DataView} payload - The message payload.
   */
  constructor(commandId, payload) {
    this.commandId = commandId
    this.payload = payload
  }
}

class Countdown {
  #clock = null
  #stopHandler = null
  #completeHandler = null

  /**
   * @param {HTMLElement|null} el - The HTML element to display the countdown.
   * @param {number} seconds - The number of seconds for the countdown.
   */
  constructor(el, seconds) {
    this.el = el
    this.seconds = seconds

    if (this.el === null) {
      throw new Error('The HTML element could not be found to mount the countdown.')
    }
  }

  start() {
    this.stop()

    let remaining = this.seconds
    this.#clock = setInterval(() => {
      this.el.textContent = `${--remaining}s`
      if (remaining === 0) {
        this.stop()
        this.notifyComplete()
      }
    }, 1000)
  }

  stop() {
    if (! this.#clock) {
      return
    }

    clearInterval(this.#clock)
    this.#clock = null

    if (this.#stopHandler) {
      this.#stopHandler()
    }
  }

  onStop(callback) {
    this.#stopHandler = callback
  }

  onComplete(callback) {
    this.#completeHandler = callback
  }

  notifyComplete() {
    if (this.#completeHandler) {
      this.#completeHandler()
    }
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

  /** @type {Countdown} */
  #countdown

  /** @type {HTMLElement|null} */
  #description

  /** @type {string} */
  #descriptionText

  /** @type {Progress} */
  #progress

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
   * The callback handles the registered device.
   *
   * @type {CallableFunction|null}
   */
  #pairHandler = null

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
    this.#setupCounter()
    this.#setupProgress()
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

  #setupCounter() {
    this.#description = this.form.querySelector('.form__description')
    this.#descriptionText = this.#description ? this.#description.textContent : ''
    this.#countdown = new Countdown(this.#description, 30)
    this.#countdown.onComplete(() => {
      this.#progress.clear()
      this.disconnectIfNeeded()
      this.transitToFailureResultForm()
    })
    this.#countdown.onStop(() => {
      this.#description.textContent = this.#descriptionText
    })
  }

  #setupProgress() {
    const el = this.form.querySelector('[data-slot="progress"]')
    this.#progress = new Progress(el, [
      { id: 'handshake', name: 'Say a hello to the machine' },
      { id: 'wifi', name: 'Send Wi-Fi credentials' },
      { id: 'identity', name: 'Receive the device\'s identity' }
    ])
  }

  async startPairing() {
    try {
      await this.connect()
    } catch {
      this.showRetryOption()
    }
  }

  async connect() {
    await this.#handler.connect()

    this.#countdown.start()
    this.#progress.render()

    this.#progress.markAsCurrent('handshake')
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
    this.#progress.markAsComplete('handshake')
    this.#progress.markAsCurrent('wifi')
    this.#handler.dispatch(this.#wifiCredentialsCommand)
  }

  /**
   * @param {CompleteMessage} message
   */
  handleWifiCredentialsMessage(message) {
    this.#progress.markAsComplete('wifi')
    this.#progress.markAsCurrent('identity')
    this.#handler.dispatch(this.#identityCommand)
  }

  /**
   * @param {CompleteMessage} message
   */
  handleIdentityMessage(message) {
    this.#countdown.stop()
    this.#progress.markAsComplete('identity')
    this.#progress.clear()
    this.disconnectIfNeeded()

    if (this.#pairHandler) {
      const length = message.payload.getUint8(0)
      if (length === 4) {
        const deviceId = message.payload.getUint32(1)
        this.#pairHandler(deviceId)
      }
    }

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

  /**
   * @param {CallableFunction} handler
   */
  onPair(handler) {
    this.#pairHandler = handler
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

class SuccessForm extends Form {
  /** @type {HTMLElement} */
  #inputGroup

  /** @type {HTMLElement} */
  #input

  /** @type {HTMLElement} */
  #button

  /** @type {string|null} */
  #deviceId = null

  /** @type {string|null} */
  #key = null

  constructor(id) {
    super(id)
    this.#inputGroup = this.form.querySelector('[data-key]')
    if (this.#inputGroup === null) {
      throw new Error('Could not find the input group for device key.')
    }
    this.#renderInput()
  }

  #renderInput() {
    this.#input = document.createElement('input')
    this.#input.classList.add('input')
    this.#input.setAttribute('type', 'text')
    this.#input.setAttribute('name', 'key')
    this.#input.setAttribute('value', 'Loading...')
    this.#input.setAttribute('readonly', '')
    this.#inputGroup.appendChild(this.#input)
  }

  #renderButton() {
    this.#button = document.createElement('button')
    this.#button.classList.add('button')
    this.#button.setAttribute('type', 'button')
    this.#button.addEventListener('click', this.#handleButtonClick.bind(this))
    this.#button.innerText = 'Copy'
    this.#inputGroup.appendChild(this.#button)
  }

  onDisplay() {
    if (this.#key === null) {
      this.#initializeDeviceKey()
    }
  }

  async #initializeDeviceKey() {
    try {
      this.#key = await this.#fetchDeviceKey()

      if (this.#key === null) {
        this.#handleDeviceKeyRetrievalFailure()
        return
      }

      this.#input.value = this.#key
      this.#renderButton()
    } catch {
      this.#handleDeviceKeyRetrievalFailure()
    }
  }

  async #fetchDeviceKey() {
    if (this.#deviceId === null) {
      return null
    }

    // We are using HTTP because the domain name is remapped to our local
    // mock server, and the communication between the device and our mock
    // server utilizes the HTTP protocol as well.
    const response = await fetch(`http://i.airmx.cn/exchange?device=${this.#deviceId}`)

    if (! response.ok) {
      throw new Error('Could not retrieve the device key.')
    }

    const data = await response.json()
    return data.key
  }

  async #handleButtonClick() {
    if (! this.#input) {
      return
    }

    try {
      await navigator.clipboard.writeText(this.#input.value)
      this.#alert('Copied to the clipboard.')
    } catch {
      this.#alert('Unable to copy to the clipboard because of permission issues.')
    }
  }

  /**
   * @param {string} message
   */
  #alert(message) {
    this.form.querySelector('.help-text')?.remove()

    const element = document.createElement('div')
    element.classList.add('help-text')
    element.textContent = message

    this.form.appendChild(element)
  }

  #handleDeviceKeyRetrievalFailure() {
    this.#input.value = 'Could not retrieve the device key.'
  }

  /**
   * @param {number} deviceId
   */
  deviceIdUsing(deviceId) {
    this.#deviceId = deviceId
    return this
  }
}

class FailureForm extends ProgressibleForm {
  constructor(id) {
    super(id)
    this.form.addEventListener('submit', this.handleSubmit.bind(this))
  }

  handleSubmit(event) {
    event.preventDefault()
    this.transitToNextForm()
  }
}

class Progress {
  #el
  #steps

  /**
   * @param {HTMLElement|null} el - The HTML element to display the progress.
   * @param {{ id: string, name: string }[]} steps - The progress steps.
   */
  constructor(el, steps) {
    this.#el = el
    this.#steps = steps
    if (this.#el === null) {
      throw new Error('The HTML element could not be found to mount the progress.')
    }
  }

  render() {
    if (! this.#el.classList.contains('progress')) {
      this.#el.classList.add('progress')
    }

    for (const step of this.#steps) {
      const el = document.createElement('li')
      el.innerText = step.name
      el.classList.add('progress__item')
      el.dataset.progress = step.id
      this.#el.appendChild(el)
    }
  }

  clear() {
    this.#el.innerHTML = ''
  }

  /**
   * @param {string} step - The step ID.
   */
  markAsCurrent(step) {
    this.markAsDefault(step)

    const el = this.#stepElement(step)
    el.dataset.current = ''
  }

  /**
   * @param {string} step - The step ID.
   */
  markAsComplete(step) {
    this.markAsDefault(step)

    const el = this.#stepElement(step)
    el.dataset.complete = ''
  }

  /**
   * @param {string} step - The step ID.
   */
  markAsDefault(step) {
    const el = this.#stepElement(step)
    if ('current' in el.dataset) {
      delete el.dataset.current
    }
    if ('complete' in el.dataset) {
      delete el.dataset.complete
    }
  }

  /**
   * @param {string} id - The step ID.
   */
  #stepElement(id) {
    const el = this.#el.querySelector(`[data-progress="${id}"]`)
    if (! el) {
      throw new Error(`Progress step "${step}" does not exist.`)
    }
    return el
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

    const successForm = new SuccessForm('form-result-success')
    const failureForm = new FailureForm('form-result-failure')

    const handler = new BluetoothHandler(Device.airmxPro())
    const communicationForm = new CommunicationForm('form-communication', handler)
      .succeedTo(successForm)
      .failTo(failureForm)
      .onPair((deviceId) => {
        successForm.deviceIdUsing(deviceId)
      })

    const pairingActivationForm = new PairingActivationForm('form-pairing-activation')
      .nextTo(communicationForm)

    const wifiCredentialsForm = new WifiCredentialsForm('form-wifi-credentials')
      .nextTo(pairingActivationForm)
      .onSubmit((credentials) => {
        communicationForm.wifiCredentialsUsing(credentials)
      })

    // If the pairing process fails, we will redirect the user to the Wi-Fi
    // credentials form so that they can retry with different credentials.
    failureForm.nextTo(wifiCredentialsForm)

    // Now that everything is set up, it's time to show the user
    // the welcome screen.
    new WelcomeForm('form-welcome')
      .nextTo(wifiCredentialsForm)
      .display()
  }
}

Application.run()
