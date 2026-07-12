import type { RetainedMemoryRegistration, RetainedMemoryRegistryFacade } from "@gajae-code/utils";

import {
	getImageDimensions,
	getKittyTransmissionRetainedBytes,
	type ImageDimensions,
	ImageProtocol,
	imageFallback,
	isCursorNeutralImagePermittedInFallback,
	isTerminalGraphicsFallbackActive,
	kittyImageId,
	renderImage,
	TERMINAL,
} from "../terminal-capabilities";

import type { ViewportRowComponent, ViewportRowWindow } from "../tui";

const PROTOCOL_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const IMAGE_SOURCE_METADATA_BYTES = 160;

// Monotonic placement id allocator (kitty `p=`). Each Image instance keeps a
// stable placement id so diff-renderer repaints replace its own placement
// instead of stacking new copies, while two components showing identical
// content (same image id) still coexist as distinct placements.
let nextPlacementId = 1;
function allocatePlacementId(): number {
	const id = nextPlacementId;
	nextPlacementId = nextPlacementId >= 0x7fffffff ? 1 : nextPlacementId + 1;
	return id;
}

/**
 * A non-owning image reference. `contentId` is a stable source/blob identifier;
 * its materializers are the only route from render components to source bytes.
 * Retained-byte accounting uses UTF-8/base64 payload bytes plus conservative
 * metadata; it intentionally does not attempt to measure JS object headers.
 */
export interface ImageSource {
	contentId: string;
	mimeType: string;
	byteLength: number;
	dimensions?: ImageDimensions;
	materializeSync?: () => string | undefined;
	materialize?: () => Promise<string | undefined>;
}

export interface ImageOwnershipAudit {
	uniqueSourceBytes: number;
	duplicatedRetainedBytes: number;
	decodeConversionBytes: number;
	protocolBytes: number;
	kittyTransmissionMetadataBytes: number;
}

const sourceOwnershipByContentId = new Map<string, { byteLength: number; references: number }>();

function noteImageSource(source: ImageSource): ImageSource {
	return source;
}

function retainImageSource(source: ImageSource): void {
	if (source.contentId.endsWith(":kitty-png")) return;
	const ownership = sourceOwnershipByContentId.get(source.contentId);
	if (ownership) {
		ownership.references += 1;
		return;
	}
	sourceOwnershipByContentId.set(source.contentId, { byteLength: source.byteLength, references: 1 });
}

function releaseImageSource(source: ImageSource): void {
	const ownership = sourceOwnershipByContentId.get(source.contentId);
	if (!ownership) return;
	ownership.references -= 1;
	if (ownership.references <= 0) sourceOwnershipByContentId.delete(source.contentId);
}

export function createImageSourceFromMaterializer(
	contentId: string,
	mimeType: string,
	byteLength: number,
	materializer: Pick<ImageSource, "materializeSync" | "materialize">,
	dimensions?: ImageDimensions,
): ImageSource {
	return noteImageSource({ contentId, mimeType, byteLength, dimensions, ...materializer });
}

const protocolCache = new Map<string, string>();
let protocolCacheBytes = 0;
let protocolCacheConversionBytes = 0;

function isConversionCacheKey(key: string): boolean {
	return key.endsWith(":kitty:image/png");
}

function protocolCachePut(key: string, value: string): void {
	const existing = protocolCache.get(key);
	if (existing) {
		const existingBytes = Buffer.byteLength(key) + Buffer.byteLength(existing);
		protocolCacheBytes -= existingBytes;
		if (isConversionCacheKey(key)) protocolCacheConversionBytes -= existingBytes;
	}
	const bytes = Buffer.byteLength(key) + Buffer.byteLength(value);
	if (bytes > PROTOCOL_CACHE_MAX_BYTES) return;
	protocolCache.set(key, value);
	protocolCacheBytes += bytes;
	if (isConversionCacheKey(key)) protocolCacheConversionBytes += bytes;
	while (protocolCacheBytes > PROTOCOL_CACHE_MAX_BYTES) {
		const oldest = protocolCache.entries().next().value as [string, string] | undefined;
		if (!oldest) break;
		protocolCache.delete(oldest[0]);
		const oldestBytes = Buffer.byteLength(oldest[0]) + Buffer.byteLength(oldest[1]);
		protocolCacheBytes -= oldestBytes;
		if (isConversionCacheKey(oldest[0])) protocolCacheConversionBytes -= oldestBytes;
	}
}

function protocolCacheGet(key: string): string | undefined {
	const value = protocolCache.get(key);
	if (!value) return undefined;
	protocolCache.delete(key);
	protocolCache.set(key, value);
	return value;
}

/** Return a cached conversion or install one under the shared protocol budget. */
export async function getOrCreateImageProtocolRepresentation(
	key: string,
	create: () => Promise<string>,
): Promise<string> {
	const cached = protocolCacheGet(key);
	if (cached) return cached;
	const value = await create();
	protocolCachePut(key, value);
	return value;
}

/** Read a previously materialized shared protocol/conversion representation. */
export function getImageProtocolRepresentation(key: string): string | undefined {
	return protocolCacheGet(key);
}

/** Shared, byte-bounded cache for recomputable protocol/conversion payloads. */
export function getImageProtocolCacheAudit(): ImageOwnershipAudit {
	let uniqueSourceBytes = 0;
	let duplicatedRetainedBytes = 0;
	for (const ownership of sourceOwnershipByContentId.values()) {
		uniqueSourceBytes += ownership.byteLength;
		duplicatedRetainedBytes += ownership.byteLength * Math.max(0, ownership.references - 1);
	}
	return {
		uniqueSourceBytes,
		duplicatedRetainedBytes,
		decodeConversionBytes: protocolCacheConversionBytes,
		protocolBytes: protocolCacheBytes,
		kittyTransmissionMetadataBytes: getKittyTransmissionRetainedBytes(),
	};
}

export function clearImageProtocolCache(): void {
	protocolCache.clear();
	protocolCacheBytes = 0;
	protocolCacheConversionBytes = 0;
}

export function getImageProtocolCacheBytes(): number {
	return protocolCacheBytes;
}

/** Register only the shared recomputable protocol/conversion cache. */
export function registerImageRetainedMemory(
	registry: RetainedMemoryRegistryFacade,
	id = "tui.images",
): RetainedMemoryRegistration {
	return registry.registerPool({
		id,
		bucketNames: ["source", "duplicate", "protocol", "decode-conversion", "kitty-transmission-metadata"],
		sampleBytes: getImageProtocolCacheBytes,
		sampleBuckets: () => {
			const audit = getImageProtocolCacheAudit();
			return {
				source: audit.uniqueSourceBytes,
				duplicate: audit.duplicatedRetainedBytes,
				protocol: audit.protocolBytes,
				"decode-conversion": audit.decodeConversionBytes,
				"kitty-transmission-metadata": audit.kittyTransmissionMetadataBytes,
			};
		},
		onEvict: clearImageProtocolCache,
	});
}

/** Stable content id without retaining source payload in a cache key. */
export function imageContentId(base64Data: string): string {
	return `image:${new Bun.SHA256().update(base64Data).digest("hex")}`;
}

export function createImageSource(
	base64Data: string,
	mimeType: string,
	dimensions?: ImageDimensions,
	contentId = imageContentId(base64Data),
): ImageSource {
	return noteImageSource({
		contentId,
		mimeType,
		byteLength: Buffer.byteLength(base64Data, "base64") + IMAGE_SOURCE_METADATA_BYTES,
		dimensions,
		materializeSync: () => base64Data,
	});
}

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	/** @deprecated Prefer ImageSource.materializeSync. */
	refetch?: () => string;
}

export class Image implements ViewportRowComponent {
	#source: ImageSource;
	#dimensions: ImageDimensions;
	#theme: ImageTheme;
	#options: ImageOptions;
	#cachedLines?: string[];
	#cachedWidth?: number;
	#cachedFallbackActive?: boolean;
	#cachedProtocol?: ImageProtocol | null;
	#releaseSourceAfterRender: boolean;
	// Computed lazily so non-kitty terminals never pay the hash cost.
	#kittyImageId?: number;
	readonly #kittyPlacementId = allocatePlacementId();
	#ownsSource = false;

	constructor(
		source: ImageSource | string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.#source = typeof source === "string" ? createImageSource(source, mimeType, dimensions) : source;
		this.#releaseSourceAfterRender = typeof source === "string";
		this.#theme = theme;
		this.#options = options;
		this.#dimensions = this.#source.dimensions ||
			dimensions ||
			this.#sourceMaterializedDimensions() || { widthPx: 800, heightPx: 600 };
		retainImageSource(this.#source);
		this.#ownsSource = true;
	}

	#sourceMaterializedDimensions(): ImageDimensions | null {
		const data = this.#source.materializeSync?.();
		return data ? getImageDimensions(data, this.#source.mimeType) : null;
	}

	invalidate(): void {
		this.#cachedLines = undefined;
		this.#cachedWidth = undefined;
		this.#cachedFallbackActive = undefined;
		this.#cachedProtocol = undefined;
	}

	dispose(): void {
		this.invalidate();
		if (this.#ownsSource) {
			releaseImageSource(this.#source);
			this.#ownsSource = false;
		}
		this.#source = { contentId: this.#source.contentId, mimeType: this.#source.mimeType, byteLength: 0 };
	}

	get retainedBase64DataForTest(): string | undefined {
		return this.#source.materializeSync?.();
	}

	get contentIdForTest(): string {
		return this.#source.contentId;
	}

	#fallbackLines(): string[] {
		const fallback = imageFallback(this.#source.mimeType, this.#dimensions, this.#options.filename);
		return [this.#theme.fallbackColor(fallback)];
	}

	#getBase64Data(): string | undefined {
		return this.#source.materializeSync?.() ?? this.#options.refetch?.();
	}

	#render(width: number): string[] {
		// Kitty placements are cursor-neutral, so an opted-in fallback scope
		// (e.g. the IRC split) can still render them safely; iTerm2/SIXEL
		// advance the cursor and stay suppressed.
		const graphicsSuppressed =
			isTerminalGraphicsFallbackActive() &&
			!(TERMINAL.imageProtocol === ImageProtocol.Kitty && isCursorNeutralImagePermittedInFallback());
		const protocol = TERMINAL.imageProtocol;
		if (
			this.#cachedLines &&
			this.#cachedWidth === width &&
			this.#cachedFallbackActive === graphicsSuppressed &&
			this.#cachedProtocol === protocol
		) {
			return this.#cachedLines;
		}
		const cap = this.#options.maxWidthCells;
		const maxWidth = cap != null && cap > 0 ? Math.min(width - 2, cap) : width - 2;
		let lines: string[];

		if (protocol && !graphicsSuppressed) {
			const base64Data = this.#getBase64Data();
			if (!base64Data) {
				lines = this.#fallbackLines();
			} else {
				if (protocol === ImageProtocol.Kitty) {
					this.#kittyImageId ??= kittyImageId(base64Data);
				}
				const protocolKey = `${this.#source.contentId}:${protocol}:${maxWidth}:${this.#options.maxHeightCells ?? ""}`;
				const cachedSequence = protocolCacheGet(protocolKey);
				const result = renderImage(base64Data, this.#dimensions, {
					maxWidthCells: maxWidth,
					maxHeightCells: this.#options.maxHeightCells,
					imageId: this.#kittyImageId,
					placementId: this.#kittyPlacementId,
				});
				if (result) {
					if (this.#releaseSourceAfterRender) {
						this.#source = {
							contentId: this.#source.contentId,
							mimeType: this.#source.mimeType,
							byteLength: 0,
						};
					}
					const sequence = result.cursorNeutral ? result.sequence : (cachedSequence ?? result.sequence);
					if (!result.cursorNeutral && !cachedSequence) protocolCachePut(protocolKey, result.sequence);
					if (result.cursorNeutral) {
						lines = [sequence, ...Array.from({ length: result.rows - 1 }, () => "")];
					} else {
						const moveUp = result.rows > 1 ? `\x1b[${result.rows - 1}A` : "";
						lines = [...Array.from({ length: result.rows - 1 }, () => ""), moveUp + sequence];
					}
				} else lines = this.#fallbackLines();
			}
		} else lines = this.#fallbackLines();
		if (TERMINAL.imageProtocol === ImageProtocol.Kitty || !TERMINAL.imageProtocol) {
			this.#cachedLines = lines;
			this.#cachedWidth = width;
		} else {
			// iTerm2/SIXEL sequences can embed the complete image payload. The frame
			// owns visible rows; component instances must not retain a second copy.
			this.#cachedLines = undefined;
			this.#cachedWidth = undefined;
		}
		if (this.#cachedLines !== undefined) {
			this.#cachedFallbackActive = graphicsSuppressed;
			this.#cachedProtocol = protocol;
		} else {
			this.#cachedFallbackActive = undefined;
			this.#cachedProtocol = undefined;
		}
		return lines;
	}

	getLogicalRowCount(width: number): number {
		return this.#render(width).length;
	}

	renderRows(width: number, start: number, end: number): string[] {
		return this.#render(width).slice(Math.max(0, start), Math.max(0, end));
	}

	renderRowsWithMetadata(width: number, start: number, end: number): ViewportRowWindow {
		const lines = this.#render(width).slice(Math.max(0, start), Math.max(0, end));
		return { lines, metadata: Array(lines.length).fill(null) };
	}

	render(width: number): string[] {
		return this.#render(width);
	}
}
