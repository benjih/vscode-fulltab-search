export interface SearchQuery {
	id: string
	pattern: string
	include: string
	exclude: string
	caseSensitive: boolean
	wholeWord: boolean
	useRegex: boolean
	replace: string
}

export interface TokenSpan {
	text: string
	color: string | null
}

export interface ContextLine {
	line: number
	text: string
	tokens?: TokenSpan[]
}

export interface SearchMatch {
	id: number
	file: string
	relativePath: string
	line: number
	column: number
	lineText: string
	matchStart: number
	matchEnd: number
	contextBefore: ContextLine[]
	contextAfter: ContextLine[]
	breadcrumb: string
	tokens?: TokenSpan[]
}

export interface FileResult {
	file: string
	relativePath: string
	directory: string
	fileName: string
	matches: SearchMatch[]
}

export interface SearchResults {
	queryId: string
	fileResults: FileResult[]
	total: number
	truncated: boolean
}

export interface SearchState {
	pattern: string
	include: string
	exclude: string
	caseSensitive: boolean
	wholeWord: boolean
	useRegex: boolean
	replace: string
}

export type WebviewMessage =
	| { type: "search"; state: SearchState }
	| { type: "cancel" }
	| { type: "openMatch"; file: string; line: number; column: number }
	| {
			type: "replaceMatch"
			file: string
			line: number
			column: number
			length: number
			replacement: string
	  }
	| { type: "replaceAll"; state: SearchState }
	| {
			type: "expandMatch"
			matchId: number
			file: string
			direction: "before" | "after"
			anchorLine: number
			count: number
	  }
	| { type: "ready" }

export type ExtensionMessage =
	| { type: "init"; state: SearchState | null }
	| { type: "searching" }
	| { type: "results"; results: SearchResults }
	| { type: "error"; message: string }
	| { type: "replaced"; count: number }
	| {
			type: "expanded"
			matchId: number
			direction: "before" | "after"
			lines: ContextLine[]
			hasMore: boolean
	  }
	| {
			type: "contextTokens"
			queryId: string
			file: string
			tokensByLine: Array<{ line: number; tokens: TokenSpan[] }>
	  }
	| {
			type: "matchTokens"
			queryId: string
			tokens: Array<{ matchId: number; tokens: TokenSpan[] }>
	  }
