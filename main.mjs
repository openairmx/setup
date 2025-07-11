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

async function connect() {
  const ssid = document.getElementById('ssid')
  const password = document.getElementById('password')

  if (ssid.value === '' || password.value === '') {
    return
  }

  const device = Device.airmxPro()
  const wifiCredentials = { ssid: ssid.value, password: password.value }
  await connectToDevice(device, wifiCredentials)
}

async function connectToDevice(device, wifiCredentials) {
  const bluetoothDevice = await navigator.bluetooth.requestDevice({
    filters: [{ name: device.name }],
    optionalServices: [device.primaryServiceUuid]
  })

  const server = await bluetoothDevice.gatt.connect()
  const service = await server.getPrimaryService(device.primaryServiceUuid)

  const writeCharacteristic = await service.getCharacteristic(device.writeCharacteristicUuid)
  const notifyCharacteristic = await service.getCharacteristic(device.notifyCharacteristicUuid)

  await notifyCharacteristic.startNotifications()
  notifyCharacteristic.addEventListener('characteristicvaluechanged', handleDeviceResponse)

  const dispatcher = new Dispatcher(writeCharacteristic)
  await dispatcher.dispatch(new HandshakeCommand())
  await dispatcher.dispatch(new ConfigureWifiCommand(wifiCredentials.ssid, wifiCredentials.password))
  await dispatcher.dispatch(new RequestIdentityCommand())
}

function handleDeviceResponse(event) {
  const value = event.target.value
  const receivedBytes = []
  for (let i = 0; i < value.byteLength; i++) {
    receivedBytes.push(value.getUint8(i).toString(16).padStart(2, '0'))
  }
  console.log(`Received data from device: ${receivedBytes.join(' ')}`)
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
  }

  hide() {
    this.form.classList.remove(this.#activeClassName)
  }
}

class ProgressibleForm extends Form {
  #nextForm = null

  nextTo(form) {
    this.#nextForm = form
    return this
  }

  nextForm() {
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
    this.nextForm()
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
      this.nextForm()
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
    this.nextForm()
  }
}

class CommunicationForm extends Form {
  #successForm = null
  #failureForm = null
  #wifiCredentials = null

  succeedTo(form) {
    this.#successForm = form
    return this
  }

  failTo(form) {
    this.#failureForm = form
    return this
  }

  wifiCredentialsUsing(credentials) {
    this.#wifiCredentials = credentials
    return this
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

    const successForm = new Form('form-result-success')
    const failureForm = new Form('form-result-failure')
    const communicationForm = new CommunicationForm('form-communication')
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
