export type MessageStatus = 'sending' | 'sent' | 'error' | 'received'

export type Message = {
  id: string
  text: string
  direction: 'outgoing' | 'incoming'
  status: MessageStatus
  timestamp: number
}

export type Chat = {
  id: string
  phone: string
  name: string
  messages: Message[]
}
