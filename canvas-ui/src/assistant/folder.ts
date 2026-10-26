// 本地文件夹授权：句柄存 IndexedDB，刷新后还能恢复（File System Access API）。
export interface FolderInfo {
	name: string
	count: number
	handle: FileSystemDirectoryHandle
}

export interface FolderFile {
	name: string
	url: string
	kind: string
}

const DB_NAME = "novai-canvas-assistant"
const STORE_NAME = "folder-handles"
const KEY = "last"

let remembered: FileSystemDirectoryHandle | null = null

export const folderSupported = (): boolean =>
	typeof window !== "undefined" && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function"

const openDb = (): Promise<IDBDatabase> =>
	new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1)
		request.onupgradeneeded = () => {
			const db = request.result
			if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
		}
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})

const saveHandle = async (handle: FileSystemDirectoryHandle): Promise<void> => {
	try {
		const db = await openDb()
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, "readwrite")
			tx.objectStore(STORE_NAME).put(handle, KEY)
			tx.oncomplete = () => resolve()
			tx.onerror = () => reject(tx.error)
		})
		db.close()
	} catch {
		/* 浏览器不允许持久化时仍可在本次会话使用 */
	}
}

const loadHandle = async (): Promise<FileSystemDirectoryHandle | null> => {
	try {
		const db = await openDb()
		const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, "readonly")
			const request = tx.objectStore(STORE_NAME).get(KEY)
			request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle) || null)
			request.onerror = () => reject(request.error)
		})
		db.close()
		return handle
	} catch {
		return null
	}
}

const readPermission = async (handle: FileSystemDirectoryHandle, request: boolean): Promise<boolean> => {
	try {
		const anyHandle = handle as unknown as {
			queryPermission?: (options: { mode: "read" }) => Promise<string>
			requestPermission?: (options: { mode: "read" }) => Promise<string>
		}
		let state = anyHandle.queryPermission ? await anyHandle.queryPermission({ mode: "read" }) : "granted"
		if (state !== "granted" && request && anyHandle.requestPermission) {
			state = await anyHandle.requestPermission({ mode: "read" })
		}
		return state === "granted"
	} catch {
		return false
	}
}

const countFiles = async (handle: FileSystemDirectoryHandle): Promise<number> => {
	let count = 0
	try {
		for await (const entry of (handle as unknown as { values: () => AsyncIterable<{ kind: string }> }).values()) {
			if (entry.kind === "file") count += 1
		}
	} catch {
		/* 权限被收回时保留 0 */
	}
	return count
}

export const chooseFolder = async (): Promise<FolderInfo | null> => {
	const picker = (window as unknown as { showDirectoryPicker?: (options?: { mode?: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker
	if (typeof picker !== "function") throw new Error("当前浏览器不支持选择本地文件夹")
	const handle = await picker({ mode: "read" })
	if (!(await readPermission(handle, true))) throw new Error("没有拿到文件夹读取权限")
	const count = await countFiles(handle)
	remembered = handle
	await saveHandle(handle)
	return { name: handle.name || "本地文件夹", count, handle }
}

export const restoreFolder = async (): Promise<FolderInfo | null> => {
	const handle = await loadHandle()
	if (!handle) return null
	if (!(await readPermission(handle, false))) return null
	remembered = handle
	const count = await countFiles(handle)
	return { name: handle.name || "本地文件夹", count, handle }
}

export const listFolderFiles = async (limit = 20): Promise<FolderFile[]> => {
	const handle = remembered || (await loadHandle())
	if (!handle) return []
	if (!(await readPermission(handle, true))) throw new Error("文件夹授权已失效，请重新添加")
	remembered = handle
	const files: FolderFile[] = []
	try {
		for await (const entry of (handle as unknown as { values: () => AsyncIterable<any> }).values()) {
			if (entry.kind !== "file" || files.length >= limit) continue
			const file = (await entry.getFile()) as File
			const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "file"
			let url = ""
			if (kind === "image" && file.size <= 8 * 1024 * 1024) {
				url = await new Promise<string>((resolve) => {
					const reader = new FileReader()
					reader.onload = () => resolve(String(reader.result || ""))
					reader.onerror = () => resolve("")
					reader.readAsDataURL(file)
				})
			}
			files.push({ name: file.name, url, kind })
			if (files.length >= limit) break
		}
	} catch {
		/* 读取中断时返回已读到的文件 */
	}
	return files
}
