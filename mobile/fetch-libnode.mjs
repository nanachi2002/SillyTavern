#!/usr/bin/env node
/**
 * Downloads libnode.so (Node.js for Android) from the nodejs-mobile releases and installs it
 * into android/app/libnode/bin/<abi>/ for the Gradle build.
 *
 * Usage: node mobile/fetch-libnode.mjs [--version 18.20.4] [--url <zip url>] [--file <local zip>] [--force]
 *
 * 64-bit libraries are prepared for devices with 16 KB memory pages (Android 15+) when that
 * can be done safely, see align16k().
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const mobileDir = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(mobileDir, '..', 'android', 'app', 'libnode', 'bin');
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64'];
const PAGE_16K = 0x4000;

const args = process.argv.slice(2);
const option = (name) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
};
const version = option('version') ?? '18.20.4';
const url = option('url') ?? process.env.LIBNODE_URL ?? `https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v${version}/nodejs-mobile-v${version}-android.zip`;
const localFile = option('file');
const force = args.includes('--force');

function log(message) {
    console.log(`\x1b[36m[fetch-libnode]\x1b[0m ${message}`);
}

/**
 * Minimal ZIP reader (central directory + stored/deflated entries).
 * @param {Buffer} data ZIP file contents
 * @returns {Map<string, () => Buffer>} Entry name -> lazy content getter
 */
function readZip(data) {
    let eocd = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
        if (data.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('Not a ZIP file');
    let entries = data.readUInt16LE(eocd + 10);
    let cdOffset = data.readUInt32LE(eocd + 16);
    // ZIP64
    if (cdOffset === 0xffffffff || entries === 0xffff) {
        const locator = eocd - 20;
        if (data.readUInt32LE(locator) !== 0x07064b50) throw new Error('Unsupported ZIP64 archive');
        const eocd64 = Number(data.readBigUInt64LE(locator + 8));
        entries = Number(data.readBigUInt64LE(eocd64 + 32));
        cdOffset = Number(data.readBigUInt64LE(eocd64 + 48));
    }
    const result = new Map();
    let p = cdOffset;
    for (let i = 0; i < entries; i++) {
        if (data.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
        const method = data.readUInt16LE(p + 10);
        let compressedSize = data.readUInt32LE(p + 20);
        const nameLength = data.readUInt16LE(p + 28);
        const extraLength = data.readUInt16LE(p + 30);
        const commentLength = data.readUInt16LE(p + 32);
        let localOffset = data.readUInt32LE(p + 42);
        const name = data.toString('utf8', p + 46, p + 46 + nameLength);
        // ZIP64 extra field
        let extra = p + 46 + nameLength;
        const extraEnd = extra + extraLength;
        while (extra + 4 <= extraEnd) {
            const id = data.readUInt16LE(extra);
            const size = data.readUInt16LE(extra + 2);
            if (id === 0x0001) {
                let q = extra + 4;
                if (data.readUInt32LE(p + 24) === 0xffffffff) q += 8;
                if (compressedSize === 0xffffffff) {
                    compressedSize = Number(data.readBigUInt64LE(q));
                    q += 8;
                }
                if (localOffset === 0xffffffff) localOffset = Number(data.readBigUInt64LE(q));
            }
            extra += 4 + size;
        }
        result.set(name, () => {
            const localNameLength = data.readUInt16LE(localOffset + 26);
            const localExtraLength = data.readUInt16LE(localOffset + 28);
            const start = localOffset + 30 + localNameLength + localExtraLength;
            const raw = data.subarray(start, start + compressedSize);
            if (method === 0) return Buffer.from(raw);
            if (method === 8) return zlib.inflateRawSync(raw);
            throw new Error(`Unsupported compression method ${method} for ${name}`);
        });
        p += 46 + nameLength + extraLength + commentLength;
    }
    return result;
}

/**
 * Parses the program headers of a 64-bit little-endian ELF file.
 * @param {Buffer} elf ELF file
 */
function readElf64(elf) {
    if (elf.readUInt32BE(0) !== 0x7f454c46) throw new Error('Not an ELF file');
    if (elf[4] !== 2 || elf[5] !== 1) return null; // not ELF64 little-endian
    const phoff = Number(elf.readBigUInt64LE(32));
    const shoff = Number(elf.readBigUInt64LE(40));
    const phentsize = elf.readUInt16LE(54);
    const phnum = elf.readUInt16LE(56);
    const shentsize = elf.readUInt16LE(58);
    const shnum = elf.readUInt16LE(60);
    const phdrs = [];
    for (let i = 0; i < phnum; i++) {
        const o = phoff + i * phentsize;
        phdrs.push({
            index: i,
            headerOffset: o,
            type: elf.readUInt32LE(o),
            flags: elf.readUInt32LE(o + 4),
            offset: Number(elf.readBigUInt64LE(o + 8)),
            vaddr: Number(elf.readBigUInt64LE(o + 16)),
            filesz: Number(elf.readBigUInt64LE(o + 32)),
            memsz: Number(elf.readBigUInt64LE(o + 40)),
            align: Number(elf.readBigUInt64LE(o + 48)),
        });
    }
    const shdrs = [];
    for (let i = 0; i < shnum && shoff > 0; i++) {
        const o = shoff + i * shentsize;
        shdrs.push({
            headerOffset: o,
            type: elf.readUInt32LE(o + 4),
            flags: Number(elf.readBigUInt64LE(o + 8)),
            offset: Number(elf.readBigUInt64LE(o + 24)),
            size: Number(elf.readBigUInt64LE(o + 32)),
        });
    }
    return { phdrs, shdrs, shoff, shentsize };
}

const alignUp = (value, alignment) => Math.ceil(value / alignment) * alignment;

/**
 * Makes a 64-bit library loadable on devices with 16 KB pages, if that is possible without
 * relinking. The loader requires p_align >= 16 KB and file offsets congruent to virtual
 * addresses modulo 16 KB. File offsets can be moved freely, but virtual addresses can't: if
 * two segments share a 16 KB page in memory, mapping the second one would overwrite the end
 * of the first one, so such a library has to be rebuilt with -z max-page-size=16384.
 * @param {Buffer} input Library
 * @returns {{ output: Buffer, status: 'aligned'|'repacked'|'incompatible'|'not-elf64', detail?: string }}
 */
function align16k(input) {
    const elf = readElf64(input);
    if (!elf) return { output: input, status: 'not-elf64' };
    const loads = elf.phdrs.filter(p => p.type === 1).sort((a, b) => a.vaddr - b.vaddr);

    for (let i = 1; i < loads.length; i++) {
        const previousEnd = loads[i - 1].vaddr + loads[i - 1].memsz;
        if (Math.floor((previousEnd - 1) / PAGE_16K) >= Math.floor(loads[i].vaddr / PAGE_16K)) {
            return {
                output: input,
                status: 'incompatible',
                detail: `segments ${i - 1} and ${i} share a 16 KB page (0x${previousEnd.toString(16)} / 0x${loads[i].vaddr.toString(16)})`,
            };
        }
    }
    if (loads.every(p => p.align >= PAGE_16K && p.offset % PAGE_16K === p.vaddr % PAGE_16K)) {
        return { output: input, status: 'aligned' };
    }

    // Lay the LOAD segments out again with 16 KB-congruent offsets
    const moves = [];
    let cursor = 0;
    for (const [i, segment] of loads.entries()) {
        let newOffset;
        if (i === 0) {
            if (segment.offset !== 0) throw new Error('First LOAD segment does not start at offset 0');
            newOffset = 0;
        } else {
            const remainder = segment.vaddr % PAGE_16K;
            newOffset = alignUp(Math.max(cursor - remainder, 0), PAGE_16K) + remainder;
            if (newOffset < cursor) newOffset += PAGE_16K;
        }
        moves.push({ start: segment.offset, end: segment.offset + segment.filesz, newStart: newOffset, segment });
        cursor = newOffset + segment.filesz;
    }
    const remap = (offset) => {
        const move = moves.find(m => offset >= m.start && offset < m.end);
        return move ? move.newStart + (offset - move.start) : null;
    };

    // Non-allocated sections (symbols, debug info, section names) go after the segments
    const trailing = elf.shdrs.filter(s => s.type !== 8 /* NOBITS */ && s.size > 0 && !(s.flags & 2 /* ALLOC */));
    let tail = alignUp(cursor, 8);
    const sectionMoves = new Map();
    for (const section of trailing) {
        sectionMoves.set(section, tail);
        tail = alignUp(tail + section.size, 8);
    }
    const newShoff = elf.shdrs.length ? alignUp(tail, 8) : 0;
    const output = Buffer.alloc(newShoff + elf.shdrs.length * elf.shentsize || tail);

    for (const move of moves) {
        input.copy(output, move.newStart, move.start, move.end);
    }
    for (const [section, newOffset] of sectionMoves) {
        input.copy(output, newOffset, section.offset, section.offset + section.size);
    }
    // ELF header and program headers live inside the first LOAD segment (offset 0)
    output.writeBigUInt64LE(BigInt(newShoff), 40);
    for (const phdr of elf.phdrs) {
        let newOffset = phdr.offset;
        if (phdr.type === 1) {
            newOffset = moves.find(m => m.segment === phdr).newStart;
            output.writeBigUInt64LE(BigInt(PAGE_16K), phdr.headerOffset + 48);
        } else if (phdr.filesz > 0) {
            const mapped = remap(phdr.offset);
            if (mapped === null) throw new Error(`Program header ${phdr.index} is outside the LOAD segments`);
            newOffset = mapped;
        }
        output.writeBigUInt64LE(BigInt(newOffset), phdr.headerOffset + 8);
    }
    for (const [i, section] of elf.shdrs.entries()) {
        const target = newShoff + i * elf.shentsize;
        input.copy(output, target, section.headerOffset, section.headerOffset + elf.shentsize);
        let newOffset = section.offset;
        if (sectionMoves.has(section)) {
            newOffset = sectionMoves.get(section);
        } else if (section.type !== 8 && section.size > 0) {
            newOffset = remap(section.offset) ?? section.offset;
        }
        output.writeBigUInt64LE(BigInt(newOffset), target + 24);
    }

    // Verify: congruent offsets, and segment contents unchanged apart from the ELF and
    // program headers (rewritten above) at the start of the first segment
    const check = readElf64(output);
    const headersEnd = Math.max(...elf.phdrs.map(p => p.headerOffset + 56), 64);
    for (const p of check.phdrs.filter(x => x.type === 1)) {
        if (p.offset % PAGE_16K !== p.vaddr % PAGE_16K || p.align < PAGE_16K) {
            throw new Error('16 KB repacking verification failed');
        }
        const original = loads.find(l => l.vaddr === p.vaddr);
        const skip = original.offset === 0 ? Math.min(headersEnd, original.filesz) : 0;
        if (!input.subarray(original.offset + skip, original.offset + original.filesz).equals(output.subarray(p.offset + skip, p.offset + p.filesz))) {
            throw new Error('16 KB repacking corrupted a segment');
        }
    }
    return { output, status: 'repacked' };
}

async function download(source) {
    log(`Downloading ${source}`);
    const response = await fetch(source, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status} for ${source}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

async function main() {
    const existing = ABIS.filter(abi => fs.existsSync(path.join(outputDir, abi, 'libnode.so')));
    if (existing.length === ABIS.length && !force) {
        log(`libnode.so already present for ${existing.join(', ')} (use --force to download again)`);
        return;
    }

    const archive = localFile ? fs.readFileSync(localFile) : await download(url);
    log(`Archive: ${(archive.length / 1048576).toFixed(1)} MB, sha256 ${crypto.createHash('sha256').update(archive).digest('hex')}`);
    const entries = readZip(archive);

    let installed = 0;
    for (const abi of ABIS) {
        const name = [...entries.keys()].find(n => n.endsWith(`/${abi}/libnode.so`) || n === `${abi}/libnode.so`);
        if (!name) {
            log(`${abi}: not in the archive, skipping`);
            continue;
        }
        const library = entries.get(name)();
        const { output, status, detail } = align16k(library);
        const target = path.join(outputDir, abi, 'libnode.so');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, output);
        installed++;
        const size = `${(output.length / 1048576).toFixed(1)} MB`;
        switch (status) {
            case 'aligned':
                log(`${abi}: installed (${size}), already 16 KB page aligned`);
                break;
            case 'repacked':
                log(`${abi}: installed (${size}), file layout repacked for 16 KB pages`);
                break;
            case 'incompatible':
                console.warn(`\x1b[33m[fetch-libnode] ${abi}: installed (${size}), but NOT compatible with 16 KB page devices: ${detail}.\n  It works on regular 4 KB page devices; 16 KB devices need a libnode.so linked with -z max-page-size=16384.\x1b[0m`);
                break;
            default:
                log(`${abi}: installed (${size})`);
        }
    }
    if (installed === 0) {
        throw new Error(`No libnode.so found in the archive. Entries: ${[...entries.keys()].slice(0, 20).join(', ')}`);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
    console.error(`\x1b[31m[fetch-libnode] ${error.message}\x1b[0m`);
    process.exit(1);
});


export { align16k, readElf64, readZip };
