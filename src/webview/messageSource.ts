import type { ByteRange } from '../shared/protocol';

const BLOCK_SIZE = 64 * 1024;
/** Slices at least this large bypass the block cache (large tiles / strips). */
const DIRECT_THRESHOLD = 256 * 1024;
const CACHE_BLOCKS = 512; // 32 MiB
/** Upper bound when merging adjacent requests into one read. */
const MAX_MERGED_READ = 16 * 1024 * 1024;

type Requester = (ranges: ByteRange[]) => Promise<ArrayBuffer[]>;

interface Pending {
  offset: number;
  length: number;
  resolve: (data: ArrayBuffer) => void;
  reject: (error: unknown) => void;
}

/**
 * A geotiff.js "source" that reads byte ranges through a message channel.
 *
 * Small reads (IFDs, tag arrays, small tiles) go through an LRU block cache;
 * all requests issued in the same tick are merged into a single round trip.
 */
export class MessageSource {
  private readonly cache = new Map<number, ArrayBuffer>();
  private readonly inflight = new Map<number, Promise<ArrayBuffer>>();
  private queue: Pending[] = [];
  private flushScheduled = false;

  constructor(
    private readonly size: number,
    private readonly requester: Requester,
  ) {}

  get fileSize(): number {
    return this.size;
  }

  async close(): Promise<void> {
    this.cache.clear();
  }

  fetch(slices: ByteRange[]): Promise<ArrayBuffer[]> {
    return Promise.all(slices.map((slice) => this.fetchSlice(slice)));
  }

  private async fetchSlice({ offset, length }: ByteRange): Promise<ArrayBuffer> {
    const end = Math.min(offset + length, this.size);
    if (end <= offset) {
      return new ArrayBuffer(0);
    }
    if (end - offset >= DIRECT_THRESHOLD) {
      return this.enqueue(offset, end - offset);
    }
    const first = Math.floor(offset / BLOCK_SIZE);
    const last = Math.floor((end - 1) / BLOCK_SIZE);
    const blocks: Promise<ArrayBuffer>[] = [];
    for (let id = first; id <= last; id++) {
      blocks.push(this.getBlock(id));
    }
    const data = await Promise.all(blocks);
    const base = first * BLOCK_SIZE;
    if (data.length === 1) {
      return data[0].slice(offset - base, end - base);
    }
    const out = new Uint8Array(end - offset);
    let pos = 0;
    for (let i = 0; i < data.length; i++) {
      const blockStart = base + i * BLOCK_SIZE;
      const from = Math.max(offset, blockStart) - blockStart;
      const to = Math.min(end, blockStart + data[i].byteLength) - blockStart;
      out.set(new Uint8Array(data[i], from, to - from), pos);
      pos += to - from;
    }
    return out.buffer;
  }

  private getBlock(id: number): Promise<ArrayBuffer> {
    const cached = this.cache.get(id);
    if (cached) {
      // Refresh LRU position.
      this.cache.delete(id);
      this.cache.set(id, cached);
      return Promise.resolve(cached);
    }
    let pending = this.inflight.get(id);
    if (!pending) {
      const start = id * BLOCK_SIZE;
      pending = this.enqueue(start, Math.min(BLOCK_SIZE, this.size - start)).then(
        (data) => {
          this.inflight.delete(id);
          this.cache.set(id, data);
          if (this.cache.size > CACHE_BLOCKS) {
            this.cache.delete(this.cache.keys().next().value!);
          }
          return data;
        },
        (error) => {
          this.inflight.delete(id);
          throw error;
        },
      );
      this.inflight.set(id, pending);
    }
    return pending;
  }

  private enqueue(offset: number, length: number): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      this.queue.push({ offset, length, resolve, reject });
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        setTimeout(() => this.flush(), 0);
      }
    });
  }

  private flush(): void {
    this.flushScheduled = false;
    const batch = this.queue.sort((a, b) => a.offset - b.offset);
    this.queue = [];

    // Merge requests that touch or overlap into larger reads.
    const groups: { offset: number; end: number; members: Pending[] }[] = [];
    for (const item of batch) {
      const last = groups[groups.length - 1];
      const itemEnd = item.offset + item.length;
      if (last && item.offset <= last.end && Math.max(last.end, itemEnd) - last.offset <= MAX_MERGED_READ) {
        last.end = Math.max(last.end, itemEnd);
        last.members.push(item);
      } else {
        groups.push({ offset: item.offset, end: itemEnd, members: [item] });
      }
    }

    this.requester(groups.map((g) => ({ offset: g.offset, length: g.end - g.offset }))).then(
      (results) => {
        groups.forEach((group, i) => {
          const data = results[i];
          for (const member of group.members) {
            const from = member.offset - group.offset;
            member.resolve(
              group.members.length === 1 && from === 0 && data.byteLength === member.length
                ? data
                : data.slice(from, from + member.length),
            );
          }
        });
      },
      (error) => batch.forEach((item) => item.reject(error)),
    );
  }
}
