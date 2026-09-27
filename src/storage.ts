import type { GreenCredentials } from './api'

const CREDENTIALS_KEY = 'max-green-api.credentials'

export function loadCredentials(): GreenCredentials {
  const defaults: GreenCredentials = {
    apiUrl: import.meta.env.VITE_GREEN_API_URL || 'https://api.green-api.com',
    idInstance: import.meta.env.VITE_GREEN_API_ID || '',
    apiTokenInstance: import.meta.env.VITE_GREEN_API_TOKEN || '',
  }

  try {
    const stored = localStorage.getItem(CREDENTIALS_KEY)
    return stored ? { ...defaults, ...JSON.parse(stored) } : defaults
  } catch {
    return defaults
  }
}

export function saveCredentials(credentials: GreenCredentials) {
  localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(credentials))
}
