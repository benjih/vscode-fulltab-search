import { fetchJson } from "./http"
import type { User } from "./users"

export interface Post {
	id: number
	author: User
	title: string
	body: string
}

const API_BASE = "https://api.example.com"

export async function getPost(id: number): Promise<Post> {
	return fetchJson<Post>(`${API_BASE}/posts/${id}`)
}

export async function searchPosts(query: string): Promise<Post[]> {
	const params = new URLSearchParams({ q: query })
	return fetchJson<Post[]>(`${API_BASE}/posts/search?${params}`, {
		retries: 3,
	})
}
