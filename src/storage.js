import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const DATA_KEY = 'mypa.data.v1';
const KEY_NAME = 'mypa.apikey';
const NAME_KEY = 'mypa.username';

const empty = { tasks: [], notes: [], events: [], texts: [] };

export async function loadData() {
  try {
    const raw = await AsyncStorage.getItem(DATA_KEY);
    return raw ? { ...empty, ...JSON.parse(raw) } : { ...empty };
  } catch {
    return { ...empty };
  }
}

export async function saveData(data) {
  await AsyncStorage.setItem(DATA_KEY, JSON.stringify(data));
}

// API key: encrypted storage on device (falls back to AsyncStorage on web)
export async function getApiKey() {
  if (Platform.OS === 'web') return (await AsyncStorage.getItem(KEY_NAME)) || '';
  return (await SecureStore.getItemAsync(KEY_NAME)) || '';
}

export async function setApiKey(key) {
  if (Platform.OS === 'web') return AsyncStorage.setItem(KEY_NAME, key);
  return SecureStore.setItemAsync(KEY_NAME, key);
}

export async function getUserName() {
  return (await AsyncStorage.getItem(NAME_KEY)) || '';
}

export async function setUserName(name) {
  return AsyncStorage.setItem(NAME_KEY, name);
}

const CHAT_KEY = 'mypa.chat.v1';

export async function loadChat() {
  try {
    const raw = await AsyncStorage.getItem(CHAT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function saveChat(chat) {
  try {
    await AsyncStorage.setItem(CHAT_KEY, JSON.stringify(chat));
  } catch {}
}

export async function clearChat() {
  await AsyncStorage.removeItem(CHAT_KEY);
}

export const DEFAULT_ASSISTANT = 'Jolly';

export async function getAssistantName() {
  return (await AsyncStorage.getItem('mypa.assistant')) || DEFAULT_ASSISTANT;
}

export async function setAssistantName(name) {
  return AsyncStorage.setItem('mypa.assistant', name || DEFAULT_ASSISTANT);
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const PREFS_KEY = 'mypa.prefs';
export const defaultPrefs = { theme: 'system', reminders: true, briefing: false, briefingTime: '08:00' };

export async function getPrefs() {
  try {
    const raw = await AsyncStorage.getItem(PREFS_KEY);
    return { ...defaultPrefs, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...defaultPrefs };
  }
}

export async function setPrefs(p) {
  await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(p));
}
