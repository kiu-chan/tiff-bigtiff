/**
 * CCITT fax decoder for TIFF compression 2 (Modified Huffman RLE),
 * 3 (T.4 / Group 3, 1D and 2D) and 4 (T.6 / Group 4).
 *
 * Output is bilevel data packed MSB-first with each row padded to a byte,
 * exactly like uncompressed 1-bit TIFF data. Black runs are written as 1 bits
 * (the usual PhotometricInterpretation for fax images is WhiteIsZero).
 */

// Terminating codes, index = run length (0..63).
const WHITE_TERM = [
  '00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111',
  '10011', '10100', '00111', '01000', '001000', '000011', '110100', '110101',
  '101010', '101011', '0100111', '0001100', '0001000', '0010111', '0000011', '0000100',
  '0101000', '0101011', '0010011', '0100100', '0011000', '00000010', '00000011', '00011010',
  '00011011', '00010010', '00010011', '00010100', '00010101', '00010110', '00010111', '00101000',
  '00101001', '00101010', '00101011', '00101100', '00101101', '00000100', '00000101', '00001010',
  '00001011', '01010010', '01010011', '01010100', '01010101', '00100100', '00100101', '01011000',
  '01011001', '01011010', '01011011', '01001010', '01001011', '00110010', '00110011', '00110100',
];
const BLACK_TERM = [
  '0000110111', '010', '11', '10', '011', '0011', '0010', '00011',
  '000101', '000100', '0000100', '0000101', '0000111', '00000100', '00000111', '000011000',
  '0000010111', '0000011000', '0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000',
  '00000010111', '00000011000', '000011001010', '000011001011', '000011001100', '000011001101', '000001101000', '000001101001',
  '000001101010', '000001101011', '000011010010', '000011010011', '000011010100', '000011010101', '000011010110', '000011010111',
  '000001101100', '000001101101', '000011011010', '000011011011', '000001010100', '000001010101', '000001010110', '000001010111',
  '000001100100', '000001100101', '000001010010', '000001010011', '000000100100', '000000110111', '000000111000', '000000100111',
  '000000101000', '000001011000', '000001011001', '000000101011', '000000101100', '000001011010', '000001100110', '000001100111',
];
// Make-up codes, index i = run length 64 * (i + 1) (64..1728).
const WHITE_MAKEUP = [
  '11011', '10010', '010111', '0110111', '00110110', '00110111', '01100100', '01100101',
  '01101000', '01100111', '011001100', '011001101', '011010010', '011010011', '011010100', '011010101',
  '011010110', '011010111', '011011000', '011011001', '011011010', '011011011', '010011000', '010011001',
  '010011010', '011000', '010011011',
];
const BLACK_MAKEUP = [
  '0000001111', '000011001000', '000011001001', '000001011011', '000000110011', '000000110100', '000000110101', '0000001101100',
  '0000001101101', '0000001001010', '0000001001011', '0000001001100', '0000001001101', '0000001110010', '0000001110011', '0000001110100',
  '0000001110101', '0000001110110', '0000001110111', '0000001010010', '0000001010011', '0000001010100', '0000001010101', '0000001011010',
  '0000001011011', '0000001100100', '0000001100101',
];
// Extended make-up codes shared by both colours, index i = 1792 + 64 * i (1792..2560).
const EXT_MAKEUP = [
  '00000001000', '00000001100', '00000001101', '000000010010', '000000010011', '000000010100', '000000010101',
  '000000010110', '000000010111', '000000011100', '000000011101', '000000011110', '000000011111',
];

const RUN_PEEK = 13;
const MODE_PEEK = 7;

const MODE_PASS = 7;
const MODE_HORIZONTAL = 8;
// Vertical modes are stored as (offset + 3), i.e. 0..6 for VL3..VR3.
const MODE_CODES: [number, string][] = [
  [MODE_PASS, '0001'],
  [MODE_HORIZONTAL, '001'],
  [3, '1'],
  [4, '011'],
  [5, '000011'],
  [6, '0000011'],
  [2, '010'],
  [1, '000010'],
  [0, '0000010'],
];

/** Lookup table indexed by the next `peek` bits; entry = (value << 4) | codeLength, or -1. */
function buildTable(entries: [number, string][], peek: number): Int32Array {
  const table = new Int32Array(1 << peek).fill(-1);
  for (const [value, bits] of entries) {
    const shift = peek - bits.length;
    const base = parseInt(bits, 2) << shift;
    for (let i = 0; i < 1 << shift; i++) {
      table[base | i] = (value << 4) | bits.length;
    }
  }
  return table;
}

function runEntries(term: string[], makeup: string[]): [number, string][] {
  return [
    ...term.map((code, run): [number, string] => [run, code]),
    ...makeup.map((code, i): [number, string] => [64 * (i + 1), code]),
    ...EXT_MAKEUP.map((code, i): [number, string] => [1792 + 64 * i, code]),
  ];
}

const WHITE_TABLE = buildTable(runEntries(WHITE_TERM, WHITE_MAKEUP), RUN_PEEK);
const BLACK_TABLE = buildTable(runEntries(BLACK_TERM, BLACK_MAKEUP), RUN_PEEK);
const MODE_TABLE = buildTable(MODE_CODES, MODE_PEEK);

class BitReader {
  private pos = 0;
  private readonly bitLength: number;

  constructor(private readonly data: Uint8Array) {
    this.bitLength = data.length * 8;
  }

  get eof(): boolean {
    return this.pos >= this.bitLength;
  }

  /** Next `n` (<= 24) bits, MSB first, zero-padded past the end. */
  peek(n: number): number {
    const i = this.pos >>> 3;
    const d = this.data;
    const word = ((d[i] ?? 0) << 24) | ((d[i + 1] ?? 0) << 16) | ((d[i + 2] ?? 0) << 8) | (d[i + 3] ?? 0);
    return ((word << (this.pos & 7)) >>> 0) >>> (32 - n);
  }

  skip(n: number): void {
    this.pos += n;
  }

  read(n: number): number {
    const value = this.peek(n);
    this.pos += n;
    return value;
  }

  alignToByte(): void {
    this.pos = (this.pos + 7) & ~7;
  }

  /** Consumes an EOL code (optionally preceded by zero fill bits). Returns whether one was found. */
  skipEol(): boolean {
    const start = this.pos;
    let zeros = 0;
    while (!this.eof && this.peek(1) === 0) {
      this.pos++;
      zeros++;
    }
    if (zeros >= 11 && !this.eof) {
      this.pos++; // the terminating 1 bit
      return true;
    }
    this.pos = start;
    return false;
  }
}

function readRun(reader: BitReader, table: Int32Array): number {
  let total = 0;
  for (;;) {
    const entry = table[reader.peek(RUN_PEEK)];
    if (entry < 0) {
      throw new Error('Invalid CCITT run-length code');
    }
    reader.skip(entry & 15);
    const run = entry >> 4;
    total += run;
    if (run < 64) {
      return total;
    }
  }
}

/** One-dimensional (Modified Huffman) coded row. Returns the changing elements. */
function decodeRow1D(reader: BitReader, width: number): number[] {
  const changes: number[] = [];
  let pos = 0;
  let color = 0;
  while (pos < width) {
    pos += readRun(reader, color ? BLACK_TABLE : WHITE_TABLE);
    changes.push(Math.min(pos, width));
    color ^= 1;
  }
  return changes;
}

/** Two-dimensional (READ) coded row relative to the reference row `ref`. */
function decodeRow2D(reader: BitReader, width: number, ref: number[]): number[] {
  const changes: number[] = [];
  let a0 = -1;
  let color = 0;
  let i = 0;
  const n = ref.length;
  while (a0 < width) {
    // b1: first changing element on the reference line right of a0 with the opposite colour of a0.
    let j = Math.max(0, i - 2);
    while (j < n && (ref[j] <= a0 || (j & 1) !== color)) {
      j++;
    }
    i = j;
    const b1 = j < n ? ref[j] : width;
    const b2 = j + 1 < n ? ref[j + 1] : width;

    const entry = MODE_TABLE[reader.peek(MODE_PEEK)];
    if (entry < 0) {
      throw new Error('Invalid or unsupported CCITT mode code');
    }
    reader.skip(entry & 15);
    const mode = entry >> 4;
    if (mode === MODE_PASS) {
      a0 = b2;
    } else if (mode === MODE_HORIZONTAL) {
      const start = Math.max(a0, 0);
      const a1 = start + readRun(reader, color ? BLACK_TABLE : WHITE_TABLE);
      const a2 = a1 + readRun(reader, color ? WHITE_TABLE : BLACK_TABLE);
      changes.push(Math.min(a1, width), Math.min(a2, width));
      a0 = a2;
    } else {
      const last = changes.length ? changes[changes.length - 1] : 0;
      const a1 = Math.min(Math.max(b1 + mode - 3, last), width);
      changes.push(a1);
      a0 = a1;
      color ^= 1;
    }
  }
  return changes;
}

function writeRow(out: Uint8Array, rowStart: number, changes: number[], width: number): void {
  for (let k = 0; k < changes.length; k += 2) {
    const start = changes[k];
    const end = k + 1 < changes.length ? changes[k + 1] : width;
    for (let x = start; x < end; x++) {
      out[rowStart + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
}

const REVERSED_BITS = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) {
      v |= ((i >> b) & 1) << (7 - b);
    }
    table[i] = v;
  }
  return table;
})();

export interface CcittOptions {
  compression: 2 | 3 | 4;
  width: number;
  height: number;
  /** TIFF T4Options (tag 292). */
  t4Options?: number;
  /** TIFF FillOrder (tag 266); 2 = least significant bit first. */
  fillOrder?: number;
}

export function decodeCcitt(input: Uint8Array, options: CcittOptions): Uint8Array {
  const { compression, width, height } = options;
  const t4Options = options.t4Options ?? 0;
  const rowBytes = (width + 7) >> 3;
  const out = new Uint8Array(rowBytes * height);
  const data = options.fillOrder === 2 ? input.map((b) => REVERSED_BITS[b]) : input;
  const reader = new BitReader(data);
  const g3TwoD = compression === 3 && (t4Options & 1) !== 0;

  let ref: number[] = [];
  for (let y = 0; y < height && !reader.eof; y++) {
    let changes: number[];
    try {
      if (compression === 2) {
        changes = decodeRow1D(reader, width);
        reader.alignToByte();
      } else if (compression === 3) {
        reader.skipEol();
        const oneD = g3TwoD ? reader.read(1) === 1 : true;
        changes = oneD ? decodeRow1D(reader, width) : decodeRow2D(reader, width, ref);
      } else {
        changes = decodeRow2D(reader, width, ref);
      }
    } catch {
      // Corrupt or truncated data (or end-of-block codes): keep the rows decoded so far.
      break;
    }
    writeRow(out, y * rowBytes, changes, width);
    ref = changes;
  }
  return out;
}
