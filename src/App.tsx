import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  checkAccount,
  deleteNotification,
  getAccountSettings,
  getStateInstance,
  receiveNotification,
  sendMessage,
  type GreenCredentials,
  type IncomingNotification,
} from './api'
import type { Chat, Message } from './types'
import { loadCredentials, saveCredentials } from './storage'

const MAX_MESSAGE_LENGTH = 4000

const icon = {
  search: '⌕',
  settings: '⚙',
  more: '⋮',
  send: '➤',
  plus: '+',
  check: '✓',
  doubleCheck: '✓✓',
  smile: '☺',
  attach: '⌕',
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
  }).format(timestamp)
}

function normalizePhone(value: string) {
  return value.replace(/\D/g, '')
}

function readableError(error: unknown) {
  if (error instanceof Error) return error.message
  return 'Не удалось выполнить запрос к GREEN-API.'
}

function extractIncomingText(notification: IncomingNotification) {
  const { body } = notification
  if (body.typeWebhook !== 'incomingMessageReceived') return null
  if (body.messageData?.typeMessage !== 'textMessage') return null
  const text = body.messageData.textMessageData?.textMessage?.trim()
  const chatId = body.senderData?.chatId
  if (!text || !chatId) return null

  return {
    chatId,
    text,
    senderName:
      body.senderData?.senderContactName || body.senderData?.senderName || body.senderData?.chatName,
    phone: body.senderData?.senderPhoneNumber ? String(body.senderData.senderPhoneNumber) : '',
    timestamp: body.timestamp ? body.timestamp * 1000 : Date.now(),
    id: body.idMessage || `received-${notification.receiptId}`,
  }
}

function makeMessage(text: string, direction: Message['direction'], status: Message['status'], id?: string): Message {
  return {
    id: id || `${direction}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    text,
    direction,
    status,
    timestamp: Date.now(),
  }
}

export default function App() {
  const [credentials, setCredentials] = useState<GreenCredentials>(loadCredentials)
  const [draftCredentials, setDraftCredentials] = useState<GreenCredentials>(credentials)
  const [settingsOpen, setSettingsOpen] = useState(!credentials.idInstance || !credentials.apiTokenInstance)
  const [newChatOpen, setNewChatOpen] = useState(false)
  const [newPhone, setNewPhone] = useState('')
  const [chats, setChats] = useState<Chat[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const [state, setState] = useState<string>('не подключено')
  const [accountPhone, setAccountPhone] = useState('')
  const [accountAvatar, setAccountAvatar] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const pollingRef = useRef(false)

  const activeChat = useMemo(
    () => chats.find((chat) => chat.id === activeChatId) || null,
    [activeChatId, chats],
  )

  const filteredChats = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return chats
    return chats.filter((chat) => `${chat.name} ${chat.phone} ${chat.messages.at(-1)?.text || ''}`.toLowerCase().includes(query))
  }, [chats, search])

  const saveSettings = () => {
    const next = {
      ...draftCredentials,
      apiUrl: draftCredentials.apiUrl.trim().replace(/\/+$/, ''),
      idInstance: draftCredentials.idInstance.trim(),
      apiTokenInstance: draftCredentials.apiTokenInstance.trim(),
    }
    setCredentials(next)
    saveCredentials(next)
    setSettingsOpen(false)
    setError('')
    setNotice('Данные GREEN-API сохранены в браузере.')
  }

  const connect = useCallback(async () => {
    if (!credentials.idInstance || !credentials.apiTokenInstance) {
      setSettingsOpen(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      const [stateResponse, account] = await Promise.all([
        getStateInstance(credentials),
        getAccountSettings(credentials),
      ])
      setState(stateResponse.stateInstance)
      setAccountPhone(account.phone || '')
      setAccountAvatar(account.avatar || '')
      if (stateResponse.stateInstance === 'authorized') {
        setNotice('MAX подключён. Можно создавать чаты и отправлять сообщения.')
      } else {
        setNotice(`Состояние инстанса: ${stateResponse.stateInstance}`)
      }
    } catch (e) {
      setState('ошибка')
      setError(readableError(e))
    } finally {
      setBusy(false)
    }
  }, [credentials])

  useEffect(() => {
    if (!settingsOpen && credentials.idInstance && credentials.apiTokenInstance) {
      void connect()
    }
  }, [connect, credentials.idInstance, credentials.apiTokenInstance, settingsOpen])

  const upsertIncomingChat = useCallback((notification: IncomingNotification) => {
    const incoming = extractIncomingText(notification)
    if (!incoming) return

    setChats((current) => {
      const existing = current.find((chat) => chat.id === incoming.chatId)
      const message = makeMessage(incoming.text, 'incoming', 'received', incoming.id)
      if (existing) {
        if (existing.messages.some((item) => item.id === message.id)) return current
        return current.map((chat) =>
          chat.id === incoming.chatId
            ? {
                ...chat,
                name: incoming.senderName || chat.name,
                phone: incoming.phone || chat.phone,
                messages: [...chat.messages, { ...message, timestamp: incoming.timestamp }],
              }
            : chat,
        )
      }

      return [
        ...current,
        {
          id: incoming.chatId,
          phone: incoming.phone,
          name: incoming.senderName || incoming.phone || incoming.chatId,
          messages: [{ ...message, timestamp: incoming.timestamp }],
        },
      ]
    })

    setActiveChatId((current) => current || incoming.chatId)
  }, [])

  const pollNotifications = useCallback(async () => {
    if (pollingRef.current || !credentials.idInstance || !credentials.apiTokenInstance || state !== 'authorized') return
    pollingRef.current = true
    try {
      const notification = await receiveNotification(credentials, 5)
      if (notification?.receiptId) {
        try {
          upsertIncomingChat(notification)
        } finally {
          await deleteNotification(credentials, notification.receiptId)
        }
      }
    } catch (e) {
      const message = readableError(e)
      if (!/timeout|timed out/i.test(message)) setError(message)
    } finally {
      pollingRef.current = false
    }
  }, [credentials, state, upsertIncomingChat])

  useEffect(() => {
    if (state !== 'authorized') return
    let stopped = false
    const loop = async () => {
      while (!stopped) {
        await pollNotifications()
        if (!stopped) await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
    void loop()
    return () => {
      stopped = true
    }
  }, [pollNotifications, state])

  const createChat = async () => {
    const phone = normalizePhone(newPhone)
    if (!phone) {
      setError('Введите номер телефона получателя.')
      return
    }
    if (!/^\d{11,12}$/.test(phone)) {
      setError('Номер должен содержать 11–12 цифр в международном формате.')
      return
    }

    setBusy(true)
    setError('')
    try {
      const result = await checkAccount(credentials, phone)
      if (!result.exist || !result.chatId) {
        setError('Указанный номер не найден в MAX.')
        return
      }
      setChats((current) => {
        const exists = current.find((chat) => chat.id === result.chatId)
        if (exists) return current
        return [
          ...current,
          { id: result.chatId, phone, name: phone, messages: [] },
        ]
      })
      setActiveChatId(result.chatId)
      setNewPhone('')
      setNewChatOpen(false)
      setNotice(`Чат с ${phone} создан.`)
    } catch (e) {
      setError(readableError(e))
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    const text = draft.trim()
    if (!activeChat || !text || busy) return
    if (text.length > MAX_MESSAGE_LENGTH) {
      setError(`Сообщение не может быть длиннее ${MAX_MESSAGE_LENGTH} символов.`)
      return
    }

    const localId = `local-${Date.now()}`
    const pending = makeMessage(text, 'outgoing', 'sending', localId)
    setDraft('')
    setError('')
    setChats((current) => current.map((chat) => chat.id === activeChat.id ? { ...chat, messages: [...chat.messages, pending] } : chat))

    try {
      const result = await sendMessage(credentials, activeChat.id, text)
      setChats((current) => current.map((chat) => {
        if (chat.id !== activeChat.id) return chat
        return {
          ...chat,
          messages: chat.messages.map((message) => message.id === localId ? { ...message, id: result.idMessage, status: 'sent' } : message),
        }
      }))
    } catch (e) {
      setChats((current) => current.map((chat) => chat.id === activeChat.id ? {
        ...chat,
        messages: chat.messages.map((message) => message.id === localId ? { ...message, status: 'error' } : message),
      } : chat))
      setError(readableError(e))
    }
  }

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  return (
      <div className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-top">
            <div className="brand-row">
              <div className="max-logo">M</div>
              <div>
                <div className="brand-title">MAX</div>
                <div className="brand-subtitle">GREEN-API Chat</div>
              </div>
              <button className="icon-button ghost" title="Настройки" onClick={() => { setDraftCredentials(credentials); setSettingsOpen(true) }}>{icon.settings}</button>
            </div>
            <div className="search-box">
              <span>{icon.search}</span>
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Поиск" />
            </div>
          </div>

          <div className="chat-list-header">
            <span>Чаты</span>
            <button className="round-add" title="Новый чат" onClick={() => setNewChatOpen(true)}>{icon.plus}</button>
          </div>

          <div className="chat-list">
            {filteredChats.length === 0 ? (
                <div className="empty-list">
                  <div className="empty-icon">💬</div>
                  <strong>Нет чатов</strong>
                  <span>Нажмите «+», чтобы начать диалог.</span>
                </div>
            ) : filteredChats.map((chat) => {
              const last = chat.messages.at(-1)
              return (
                  <button key={chat.id} className={`chat-preview ${chat.id === activeChatId ? 'active' : ''}`} onClick={() => setActiveChatId(chat.id)}>
                    <div className="avatar">{chat.name.slice(0, 1).toUpperCase()}</div>
                    <div className="chat-preview-content">
                      <div className="chat-preview-line">
                        <strong>{chat.name}</strong>
                        {last && <time>{formatTime(last.timestamp)}</time>}
                      </div>
                      <div className="chat-preview-line muted">
                        <span className="truncate">{last?.text || chat.phone}</span>
                        {last?.direction === 'outgoing' && <span className="preview-status">{last.status === 'error' ? '!' : icon.doubleCheck}</span>}
                      </div>
                    </div>
                  </button>
              )
            })}
          </div>

          <div className="sidebar-footer">
            <div className={`status-dot ${state === 'authorized' ? 'online' : ''}`} />
            <span>{state === 'authorized' ? 'MAX подключён' : state}</span>
            <button className="text-button" onClick={() => void connect()} disabled={busy}>Обновить</button>
          </div>
        </aside>

        <main className="chat-area">
          {activeChat ? (
              <>
                <header className="chat-header">
                  <div className="avatar large">{activeChat.name.slice(0, 1).toUpperCase()}</div>
                  <div className="chat-header-info">
                    <h1>{activeChat.name}</h1>
                    <span>{activeChat.phone || `chatId: ${activeChat.id}`}</span>
                  </div>
                  <div className="chat-header-actions">
                    <button className="icon-button" title="Поиск">{icon.search}</button>
                    <button className="icon-button" title="Дополнительно">{icon.more}</button>
                  </div>
                </header>

                <section className="messages" aria-label="История сообщений">
                  {activeChat.messages.length === 0 ? (
                      <div className="conversation-empty">
                        <div className="conversation-badge">M</div>
                        <h2>Начните общение</h2>
                        <p>Отправьте первое текстовое сообщение в MAX.</p>
                      </div>
                  ) : (
                      <div className="message-stack">
                        {activeChat.messages.map((message, index) => {
                          const previous = activeChat.messages[index - 1]
                          const showDate = !previous || formatDate(previous.timestamp) !== formatDate(message.timestamp)
                          return (
                              <div key={message.id}>
                                {showDate && <div className="date-divider"><span>{formatDate(message.timestamp)}</span></div>}
                                <div className={`message-row ${message.direction}`}>
                                  <div className={`bubble ${message.status === 'error' ? 'error' : ''}`}>
                                    <span className="bubble-text">{message.text}</span>
                                    <span className="bubble-meta">
                              {formatTime(message.timestamp)}
                                      {message.direction === 'outgoing' && (
                                          <span className={`message-check ${message.status}`}>{message.status === 'sending' ? '…' : message.status === 'error' ? '!' : icon.doubleCheck}</span>
                                      )}
                            </span>
                                  </div>
                                </div>
                              </div>
                          )
                        })}
                      </div>
                  )}
                </section>

                <footer className="composer-wrap">
                  <div className="composer">
                    <button className="composer-icon" title="Эмодзи">{icon.smile}</button>
                    <textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value.slice(0, MAX_MESSAGE_LENGTH))}
                        onKeyDown={onComposerKeyDown}
                        placeholder="Сообщение"
                        rows={1}
                    />
                    <button className="composer-icon" title="Вложения (только текст в рамках задания)">{icon.attach}</button>
                    <button className="send-button" disabled={!draft.trim() || busy || state !== 'authorized'} onClick={() => void send()} title="Отправить">
                      {icon.send}
                    </button>
                  </div>
                  <div className="composer-hint">
                    <span>Enter — отправить · Shift+Enter — новая строка</span>
                    <span>{draft.length}/{MAX_MESSAGE_LENGTH}</span>
                  </div>
                </footer>
              </>
          ) : (
              <div className="welcome">
                <div className="welcome-logo">M</div>
                <h1>MAX</h1>
                <p>Минимальный интерфейс для отправки и получения текстовых сообщений через GREEN-API.</p>
                <div className="welcome-actions">
                  <button className="primary-button" onClick={() => setNewChatOpen(true)}>Создать чат</button>
                  <button className="secondary-button" onClick={() => { setDraftCredentials(credentials); setSettingsOpen(true) }}>Настроить API</button>
                </div>
                <small>Статус: {state}{accountPhone ? ` · ${accountPhone}` : ''}</small>
              </div>
          )}
        </main>

        {(error || notice) && (
            <div className={`toast ${error ? 'toast-error' : ''}`}>
              <span>{error || notice}</span>
              <button onClick={() => { setError(''); setNotice('') }}>×</button>
            </div>
        )}

        {settingsOpen && (
            <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false) }}>
              <div className="modal">
                <div className="modal-header">
                  <div>
                    <h2>Подключение GREEN-API</h2>
                    <p>Укажите данные инстанса MAX из личного кабинета GREEN-API.</p>
                  </div>
                  <button className="icon-button" onClick={() => setSettingsOpen(false)}>×</button>
                </div>
                <label>API URL<input value={draftCredentials.apiUrl} onChange={(e) => setDraftCredentials({ ...draftCredentials, apiUrl: e.target.value })} placeholder="https://api.green-api.com" /></label>
                <label>ID Instance<input value={draftCredentials.idInstance} onChange={(e) => setDraftCredentials({ ...draftCredentials, idInstance: e.target.value })} placeholder="110100001" /></label>
                <label>API Token Instance<input type="password" value={draftCredentials.apiTokenInstance} onChange={(e) => setDraftCredentials({ ...draftCredentials, apiTokenInstance: e.target.value })} placeholder="••••••••••••••••" /></label>
                <div className="security-note">Данные сохраняются только в localStorage этого браузера и используются для запросов к GREEN-API. Для production-приложения токен лучше хранить на backend.</div>
                <div className="modal-actions">
                  <button className="secondary-button" onClick={() => setSettingsOpen(false)}>Отмена</button>
                  <button className="primary-button" onClick={saveSettings} disabled={!draftCredentials.idInstance || !draftCredentials.apiTokenInstance}>Сохранить и подключиться</button>
                </div>
              </div>
            </div>
        )}

        {newChatOpen && (
            <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setNewChatOpen(false) }}>
              <div className="modal compact">
                <div className="modal-header">
                  <div>
                    <h2>Новый чат</h2>
                    <p>Введите номер получателя в международном формате.</p>
                  </div>
                  <button className="icon-button" onClick={() => setNewChatOpen(false)}>×</button>
                </div>
                <label>Номер телефона<input autoFocus value={newPhone} onChange={(e) => setNewPhone(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void createChat() }} placeholder="79991234567" /></label>
                <div className="modal-caption">GREEN-API сначала выполнит CheckAccount и получит chatId. Это позволяет корректно принимать ответы в этом диалоге.</div>
                <div className="modal-actions">
                  <button className="secondary-button" onClick={() => setNewChatOpen(false)}>Отмена</button>
                  <button className="primary-button" onClick={() => void createChat()} disabled={busy || state !== 'authorized'}>Создать</button>
                </div>
              </div>
            </div>
        )}
      </div>
  )
}
