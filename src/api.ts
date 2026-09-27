export type GreenCredentials = {
  apiUrl: string
  idInstance: string
  apiTokenInstance: string
}

export type InstanceState =
  | 'authorized'
  | 'notAuthorized'
  | 'blocked'
  | 'starting'
  | 'suspended'
  | 'pendingPassword'
  | string

export type IncomingNotification = {
  receiptId: number
  body: {
    typeWebhook?: string
    instanceData?: Record<string, unknown>
    timestamp?: number
    idMessage?: string
    senderData?: {
      chatId?: string
      chatName?: string
      senderName?: string
      senderContactName?: string
      senderPhoneNumber?: number | string
    }
    messageData?: {
      typeMessage?: string
      textMessageData?: { textMessage?: string }
    }
  }
}

export type CheckAccountResponse = {
  exist: boolean
  chatId: string
  fromCache?: boolean
  status?: boolean
  reason?: string
}

export type ApiError = Error & { status?: number; details?: unknown }

function normalizeUrl(value: string) {
  return value.trim().replace(/\/+$/, '')
}

function endpoint(credentials: GreenCredentials, method: string, suffix = '') {
  return `${normalizeUrl(credentials.apiUrl)}/waInstance${encodeURIComponent(credentials.idInstance)}/${method}/${encodeURIComponent(credentials.apiTokenInstance)}${suffix}`
}

async function request<T>(
  credentials: GreenCredentials,
  method: string,
  init: RequestInit = {},
  suffix = '',
): Promise<T> {
  const response = await fetch(endpoint(credentials, method, suffix), {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  const text = await response.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }

  if (!response.ok) {
    const message =
      typeof data === 'object' && data !== null
        ? ((data as { message?: string; error?: string; reason?: string }).message ||
          (data as { error?: string }).error ||
          (data as { reason?: string }).reason)
        : undefined
    const error = new Error(message || `GREEN-API error: HTTP ${response.status}`) as ApiError
    error.status = response.status
    error.details = data
    throw error
  }

  return data as T
}

export function getStateInstance(credentials: GreenCredentials) {
  return request<{ stateInstance: InstanceState }>(credentials, 'getStateInstance')
}

export function getAccountSettings(credentials: GreenCredentials) {
  return request<{
    avatar?: string
    phone?: string
    stateInstance?: InstanceState
    chatId?: string
    historySyncProgress?: number
  }>(credentials, 'getAccountSettings')
}

export function checkAccount(credentials: GreenCredentials, phoneNumber: string) {
  return request<CheckAccountResponse>(credentials, 'checkAccount', {
    method: 'POST',
    body: JSON.stringify({ phoneNumber: Number(phoneNumber.replace(/\D/g, '')) }),
  })
}

export function sendMessage(credentials: GreenCredentials, chatId: string, message: string) {
  return request<{ idMessage: string }>(credentials, 'sendMessage', {
    method: 'POST',
    body: JSON.stringify({ chatId, message }),
  })
}

export async function receiveNotification(credentials: GreenCredentials, receiveTimeout = 5) {
  return request<IncomingNotification | null>(
    credentials,
    'receiveNotification',
    {},
    `?receiveTimeout=${Math.min(60, Math.max(5, receiveTimeout))}`,
  )
}

export function deleteNotification(credentials: GreenCredentials, receiptId: number) {
  return request<{ result: boolean }>(
    credentials,
    'deleteNotification',
    { method: 'DELETE' },
    `/${encodeURIComponent(String(receiptId))}`,
  )
}
