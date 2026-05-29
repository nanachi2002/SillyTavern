#!/usr/bin/env python3
"""Repack ELF shared library for 16KB page alignment (Android 15+).

Pads file offsets of PT_LOAD segments so that:
    p_offset % page_size == p_vaddr % page_size
Virtual addresses are preserved (no relocation changes).
Section headers are preserved and relocated at the end of the file.

Usage: python repack-elf-16k.py <input.so> <output.so>
"""

import struct
import sys

ELF_MAGIC = b'\x7fELF'
ELFCLASS64 = 2
ELFDATA2LSB = 1
PT_LOAD = 1
SHT_NOBITS = 8
SHF_ALLOC = 0x2
PAGE_SIZE_16K = 0x4000


def align_up(val, alignment):
    return (val + alignment - 1) & ~(alignment - 1)


def parse_elf64(data):
    ehdr = struct.unpack_from('<16sHHIQQQIHHHHHH', data, 0)
    header = {
        'e_ident':     ehdr[0],
        'e_type':      ehdr[1],
        'e_machine':   ehdr[2],
        'e_version':   ehdr[3],
        'e_entry':     ehdr[4],
        'e_phoff':     ehdr[5],
        'e_shoff':     ehdr[6],
        'e_flags':     ehdr[7],
        'e_ehsize':    ehdr[8],
        'e_phentsize': ehdr[9],
        'e_phnum':     ehdr[10],
        'e_shentsize': ehdr[11],
        'e_shnum':     ehdr[12],
        'e_shstrndx':  ehdr[13],
    }
    phdrs = []
    for i in range(header['e_phnum']):
        off = header['e_phoff'] + i * header['e_phentsize']
        p = struct.unpack_from('<IIQQQQQQ', data, off)
        phdrs.append({
            'p_type':   p[0],
            'p_flags':  p[1],
            'p_offset': p[2],
            'p_vaddr':  p[3],
            'p_paddr':  p[4],
            'p_filesz': p[5],
            'p_memsz':  p[6],
            'p_align':  p[7],
        })
    shdrs = []
    if header['e_shoff'] > 0 and header['e_shnum'] > 0:
        for i in range(header['e_shnum']):
            off = header['e_shoff'] + i * header['e_shentsize']
            s = struct.unpack_from('<IIQQQQIIQQ', data, off)
            shdrs.append({
                'sh_name':      s[0],
                'sh_type':      s[1],
                'sh_flags':     s[2],
                'sh_addr':      s[3],
                'sh_offset':    s[4],
                'sh_size':      s[5],
                'sh_link':      s[6],
                'sh_info':      s[7],
                'sh_addralign': s[8],
                'sh_entsize':   s[9],
            })
    return header, phdrs, shdrs


def find_congruent_offset(min_offset, vaddr, page_size):
    r = vaddr % page_size
    if r >= min_offset:
        return r
    base = align_up(min_offset - r, page_size)
    candidate = base + r
    if candidate < min_offset:
        candidate += page_size
    return candidate


def repack_elf64(data, page_size=PAGE_SIZE_16K):
    header, phdrs, shdrs = parse_elf64(data)
    load_entries = [(i, phdrs[i]) for i in range(len(phdrs)) if phdrs[i]['p_type'] == PT_LOAD]
    load_entries.sort(key=lambda x: x[1]['p_vaddr'])

    new_phdrs = [dict(p) for p in phdrs]
    prev_end = 0

    for idx, (orig_idx, seg) in enumerate(load_entries):
        vaddr = seg['p_vaddr']
        filesz = seg['p_filesz']

        if idx == 0:
            new_offset = 0
        else:
            new_offset = find_congruent_offset(prev_end, vaddr, page_size)

        new_phdrs[orig_idx]['p_offset'] = new_offset
        new_phdrs[orig_idx]['p_align'] = page_size

        prev_end = new_offset + filesz

    offset_map = []
    for orig_idx, seg in load_entries:
        orig_off = seg['p_offset']
        new_off = new_phdrs[orig_idx]['p_offset']
        orig_end = orig_off + seg['p_filesz']
        offset_map.append((orig_off, orig_end, new_off))

    def remap_offset(off):
        for orig_start, orig_end, new_start in offset_map:
            if orig_start <= off < orig_end:
                return new_start + (off - orig_start)
        return off

    for i in range(len(phdrs)):
        p = new_phdrs[i]
        if p['p_type'] != PT_LOAD and p['p_filesz'] > 0 and p['p_type'] != 0:
            p['p_offset'] = remap_offset(p['p_offset'])

    data_end = 0
    for p in new_phdrs:
        if p['p_type'] == PT_LOAD:
            end = p['p_offset'] + p['p_filesz']
            if end > data_end:
                data_end = end

    new_shdrs = [dict(s) for s in shdrs]
    non_alloc_sections = []
    for i, s in enumerate(new_shdrs):
        if s['sh_type'] != SHT_NOBITS and s['sh_size'] > 0:
            if s['sh_flags'] & SHF_ALLOC:
                s['sh_offset'] = remap_offset(s['sh_offset'])
            else:
                non_alloc_sections.append(i)

    sh_data_offset = align_up(data_end, 8)
    for i in non_alloc_sections:
        s = new_shdrs[i]
        s['sh_offset'] = sh_data_offset
        sh_data_offset = align_up(sh_data_offset + s['sh_size'], 1)

    new_shoff = align_up(sh_data_offset, 8)
    sh_table_size = len(new_shdrs) * header['e_shentsize']
    total_size = new_shoff + sh_table_size

    output = bytearray(total_size)

    for orig_idx, new_seg in enumerate(new_phdrs):
        if new_seg['p_type'] == PT_LOAD:
            orig = phdrs[orig_idx]
            seg_data = data[orig['p_offset']:orig['p_offset'] + orig['p_filesz']]
            output[new_seg['p_offset']:new_seg['p_offset'] + new_seg['p_filesz']] = seg_data

    for i in non_alloc_sections:
        s = shdrs[i]
        new_s = new_shdrs[i]
        sec_data = data[s['sh_offset']:s['sh_offset'] + s['sh_size']]
        output[new_s['sh_offset']:new_s['sh_offset'] + new_s['sh_size']] = sec_data

    output[:header['e_ehsize']] = data[:header['e_ehsize']]

    struct.pack_into('<Q', output, 40, new_shoff)
    struct.pack_into('<H', output, 62, header['e_shstrndx'])

    for i in range(header['e_phnum']):
        off = header['e_phoff'] + i * header['e_phentsize']
        p = new_phdrs[i]
        struct.pack_into('<IIQQQQQQ', output, off,
            p['p_type'], p['p_flags'], p['p_offset'],
            p['p_vaddr'], p['p_paddr'], p['p_filesz'],
            p['p_memsz'], p['p_align'])

    for i in range(len(new_shdrs)):
        s = new_shdrs[i]
        off = new_shoff + i * header['e_shentsize']
        struct.pack_into('<IIQQQQIIQQ', output, off,
            s['sh_name'], s['sh_type'], s['sh_flags'], s['sh_addr'],
            s['sh_offset'], s['sh_size'], s['sh_link'], s['sh_info'],
            s['sh_addralign'], s['sh_entsize'])

    return bytes(output)


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input.so> <output.so>")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    with open(input_path, 'rb') as f:
        input_data = f.read()

    print(f"Input:  {input_path} ({len(input_data):,} bytes)")
    header, phdrs, shdrs = parse_elf64(input_data)
    loads = [p for p in phdrs if p['p_type'] == PT_LOAD]
    print(f"  PT_LOAD segments: {len(loads)}")
    for i, s in enumerate(loads):
        off_mod = s['p_offset'] % PAGE_SIZE_16K
        va_mod = s['p_vaddr'] % PAGE_SIZE_16K
        print(f"    [{i}] offset=0x{s['p_offset']:x} vaddr=0x{s['p_vaddr']:x} "
              f"filesz=0x{s['p_filesz']:x} align=0x{s['p_align']:x} "
              f"congruent={off_mod == va_mod}")
    print(f"  Section headers: {len(shdrs)}")

    output_data = repack_elf64(input_data)

    with open(output_path, 'wb') as f:
        f.write(output_data)

    print(f"\nOutput: {output_path} ({len(output_data):,} bytes)")
    print(f"Size change: {len(output_data) - len(input_data):+,d} bytes")

    _, out_phdrs, out_shdrs = parse_elf64(output_data)
    out_loads = [p for p in out_phdrs if p['p_type'] == PT_LOAD]
    print(f"  PT_LOAD segments: {len(out_loads)}")

    all_ok = True
    for i, s in enumerate(out_loads):
        off_mod = s['p_offset'] % PAGE_SIZE_16K
        va_mod = s['p_vaddr'] % PAGE_SIZE_16K
        congruent = off_mod == va_mod
        all_ok = all_ok and congruent
        print(f"    [{i}] offset=0x{s['p_offset']:x} vaddr=0x{s['p_vaddr']:x} "
              f"align=0x{s['p_align']:x} congruent={congruent} {'OK' if congruent else 'FAIL'}")

    print(f"  Section headers: {len(out_shdrs)}")
    if all_ok:
        print("\n  PASS: All PT_LOAD segments are 16KB-congruent")
    else:
        print("\n  FAIL: Some segments are not properly aligned")
        sys.exit(1)


if __name__ == '__main__':
    main()