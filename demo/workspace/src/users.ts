import { fetchJson } from "./http"

export interface User {
	id: number
	name: string
	email: string
}

const API_BASE = "https://api.example.com"

export async function getUser(id: number): Promise<User> {
	return fetchJson<User>(`${API_BASE}/users/${id}`)
}

export async function listUsers(): Promise<User[]> {
	return fetchJson<User[]>(`${API_BASE}/users`, { timeoutMs: 10_000 })
}
