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

export interface ContextLine {
	line: number
	text: string
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

export interface SearchTab {
	id: string
	pattern: string
	include: string
	exclude: string
	caseSensitive: boolean
	wholeWord: boolean
	useRegex: boolean
	replace: string
}

export type WebviewMessage =
	| { type: "search"; tab: SearchTab }
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
	| { type: "replaceAll"; tab: SearchTab }
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
	| { type: "init"; tabs: SearchTab[]; activeTabId: string | null }
	| { type: "searching"; tabId: string }
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
