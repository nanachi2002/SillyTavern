/**
 * Compatibility layer for nodejs-mobile (Node.js 18, built without ICU).
 *
 * SillyTavern targets Node.js >= 20 with full ICU. This module fills the gaps so the
 * unmodified server code runs on the Android runtime. Every polyfill is guarded and only
 * installed when the feature is actually missing, so the module is a no-op on a regular
 * desktop Node.js 20+ install.
 *
 * Must be imported before any other module.
 */
import buffer from 'node:buffer';
import nodeCrypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Defines a non-enumerable property if it doesn't exist yet.
 * @param {object} target Object to patch
 * @param {string|symbol} name Property name
 * @param {any} value Property value
 */
function define(target, name, value) {
    if (name in target) return;
    Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
}

// ---------------------------------------------------------------------------
// Web platform globals that became global after Node 18
// ---------------------------------------------------------------------------
if (typeof globalThis.crypto === 'undefined' && nodeCrypto.webcrypto) {
    define(globalThis, 'crypto', nodeCrypto.webcrypto);
}
if (typeof globalThis.File === 'undefined' && buffer.File) {
    define(globalThis, 'File', buffer.File);
}
if (typeof globalThis.CustomEvent === 'undefined' && typeof globalThis.Event === 'function') {
    define(globalThis, 'CustomEvent', class CustomEvent extends Event {
        #detail;
        constructor(type, options = {}) {
            super(type, options);
            this.#detail = options?.detail ?? null;
        }
        get detail() {
            return this.#detail;
        }
    });
}

// ---------------------------------------------------------------------------
// ECMAScript 2023+ built-ins missing from V8 10.2
// ---------------------------------------------------------------------------
const arrayLikeProtos = [Array.prototype, ...[
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
    Float32Array, Float64Array, BigInt64Array, BigUint64Array,
].map(t => t.prototype)];

for (const proto of arrayLikeProtos) {
    const isTyped = proto !== Array.prototype;
    const create = (source, length) => isTyped ? new source.constructor(length) : new Array(length);
    define(proto, 'toReversed', function toReversed() {
        const length = this.length;
        const result = create(this, length);
        for (let i = 0; i < length; i++) result[i] = this[length - 1 - i];
        return result;
    });
    define(proto, 'toSorted', function toSorted(compareFn) {
        if (compareFn !== undefined && typeof compareFn !== 'function') {
            throw new TypeError('The comparison function must be either a function or undefined');
        }
        const result = isTyped ? this.slice() : Array.from(this);
        return result.sort(compareFn);
    });
    define(proto, 'with', function (index, value) {
        const length = this.length;
        const relative = Math.trunc(Number(index)) || 0;
        const actual = relative >= 0 ? relative : length + relative;
        if (actual < 0 || actual >= length) throw new RangeError('Invalid index : ' + index);
        const result = isTyped ? this.slice() : Array.from(this);
        result[actual] = value;
        return result;
    });
}
define(Array.prototype, 'toSpliced', function toSpliced(...args) {
    const copy = Array.from(this);
    copy.splice(...args);
    return copy;
});
define(Array, 'fromAsync', async function fromAsync(items, mapFn, thisArg) {
    const result = [];
    let index = 0;
    const iterable = items[Symbol.asyncIterator] ? items : (items[Symbol.iterator] ? items : Array.from(items));
    for await (const item of iterable) {
        result.push(mapFn ? await mapFn.call(thisArg, item, index) : item);
        index++;
    }
    return result;
});

define(Object, 'groupBy', function groupBy(items, callback) {
    const result = Object.create(null);
    let index = 0;
    for (const item of items) {
        const key = callback(item, index++);
        (result[key] ??= []).push(item);
    }
    return result;
});
define(Map, 'groupBy', function groupBy(items, callback) {
    const result = new Map();
    let index = 0;
    for (const item of items) {
        const key = callback(item, index++);
        if (!result.has(key)) result.set(key, []);
        result.get(key).push(item);
    }
    return result;
});
define(Promise, 'withResolvers', function withResolvers() {
    let resolve, reject;
    const promise = new this((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
});

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const loneSurrogates = new RegExp(loneSurrogate.source, 'g');
define(String.prototype, 'isWellFormed', function isWellFormed() {
    return !loneSurrogate.test(String(this));
});
define(String.prototype, 'toWellFormed', function toWellFormed() {
    return String(this).replace(loneSurrogates, '�');
});

for (const [name, fn] of Object.entries({
    union(other) {
        const result = new Set(this);
        for (const value of other.keys()) result.add(value);
        return result;
    },
    intersection(other) {
        const result = new Set();
        for (const value of this) if (other.has(value)) result.add(value);
        return result;
    },
    difference(other) {
        const result = new Set(this);
        for (const value of this) if (other.has(value)) result.delete(value);
        return result;
    },
    symmetricDifference(other) {
        const result = new Set(this);
        for (const value of other.keys()) {
            if (this.has(value)) result.delete(value); else result.add(value);
        }
        return result;
    },
    isSubsetOf(other) {
        for (const value of this) if (!other.has(value)) return false;
        return true;
    },
    isSupersetOf(other) {
        for (const value of other.keys()) if (!this.has(value)) return false;
        return true;
    },
    isDisjointFrom(other) {
        for (const value of this) if (other.has(value)) return false;
        return true;
    },
})) {
    define(Set.prototype, name, fn);
}

if (typeof AbortSignal !== 'undefined') {
    define(AbortSignal, 'any', function any(signals) {
        const controller = new AbortController();
        for (const signal of signals) {
            if (signal.aborted) {
                controller.abort(signal.reason);
                return controller.signal;
            }
        }
        for (const signal of signals) {
            signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true, signal: controller.signal });
        }
        return controller.signal;
    });
}

// ---------------------------------------------------------------------------
// TextDecoder without ICU: only supports utf-8/utf-16le/latin1 and rejects {fatal: true}
// ---------------------------------------------------------------------------
(function patchTextDecoder() {
    const NativeTextDecoder = globalThis.TextDecoder;
    if (typeof NativeTextDecoder !== 'function') return;
    try {
        new NativeTextDecoder('utf-8', { fatal: true });
        return; // fully supported
    } catch {
        // fall through and patch
    }

    const isUtf8 = typeof buffer.isUtf8 === 'function' ? buffer.isUtf8 : null;
    const toView = (input) => {
        if (input === undefined || input === null) return new Uint8Array(0);
        if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        return new Uint8Array(input);
    };

    class TextDecoder extends NativeTextDecoder {
        #fatal;
        #utf8;
        constructor(label = 'utf-8', options = {}) {
            const { fatal = false, ...rest } = options ?? {};
            super(label, rest);
            this.#fatal = !!fatal;
            this.#utf8 = this.encoding === 'utf-8';
        }
        get fatal() {
            return this.#fatal;
        }
        decode(input, options) {
            if (this.#fatal && this.#utf8 && isUtf8 && !options?.stream) {
                const view = toView(input);
                if (!isUtf8(view)) {
                    const error = new TypeError('The encoded data was not valid for encoding utf-8');
                    // @ts-ignore
                    error.code = 'ERR_ENCODING_INVALID_ENCODED_DATA';
                    throw error;
                }
            }
            return super.decode(input, options);
        }
    }
    globalThis.TextDecoder = TextDecoder;
    try {
        // util.TextDecoder is the same class in Node; keep them in sync
        require('node:util').TextDecoder = TextDecoder;
    } catch {
        // ignore
    }
})();

// ---------------------------------------------------------------------------
// Intl is undefined when Node is built without ICU
// ---------------------------------------------------------------------------
if (typeof globalThis.Intl === 'undefined') {
    const toStr = (v) => (v === undefined || v === null) ? '' : String(v);
    const pad = (n, len = 2) => String(n).padStart(len, '0');

    class Collator {
        #options;
        constructor(locales, options = {}) {
            this.#options = { sensitivity: 'variant', numeric: false, ...options };
            this.compare = this.compare.bind(this);
        }
        compare(a, b) {
            let x = toStr(a);
            let y = toStr(b);
            if (this.#options.sensitivity === 'base' || this.#options.sensitivity === 'accent') {
                x = x.toLowerCase();
                y = y.toLowerCase();
            }
            if (this.#options.numeric) {
                const rx = /(\d+)|(\D+)/g;
                const px = x.match(rx) ?? [];
                const py = y.match(rx) ?? [];
                for (let i = 0; i < Math.min(px.length, py.length); i++) {
                    const nx = /^\d/.test(px[i]);
                    const ny = /^\d/.test(py[i]);
                    if (nx && ny) {
                        const diff = Number(px[i]) - Number(py[i]);
                        if (diff !== 0) return diff < 0 ? -1 : 1;
                    } else if (px[i] !== py[i]) {
                        return px[i] < py[i] ? -1 : 1;
                    }
                }
                return px.length === py.length ? 0 : (px.length < py.length ? -1 : 1);
            }
            return x === y ? 0 : (x < y ? -1 : 1);
        }
        resolvedOptions() {
            return { locale: 'en-US', usage: 'sort', collation: 'default', ignorePunctuation: false, ...this.#options };
        }
        static supportedLocalesOf() {
            return ['en-US'];
        }
    }

    class DateTimeFormat {
        #options;
        constructor(locales, options = {}) {
            this.#options = options ?? {};
            this.format = this.format.bind(this);
        }
        format(date) {
            const d = date === undefined ? new Date() : new Date(date);
            if (isNaN(d.getTime())) throw new RangeError('Invalid time value');
            const o = this.#options;
            const hasDate = o.year || o.month || o.day || o.weekday || o.dateStyle;
            const hasTime = o.hour || o.minute || o.second || o.timeStyle;
            const datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            const timePart = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
            if (hasDate && !hasTime) return datePart;
            if (hasTime && !hasDate) return timePart;
            return `${datePart} ${timePart}`;
        }
        formatToParts(date) {
            return [{ type: 'literal', value: this.format(date) }];
        }
        resolvedOptions() {
            let timeZone = process.env.TZ || 'UTC';
            return { locale: 'en-US', calendar: 'gregory', numberingSystem: 'latn', timeZone, ...this.#options };
        }
        static supportedLocalesOf() {
            return ['en-US'];
        }
    }

    class NumberFormat {
        #options;
        constructor(locales, options = {}) {
            this.#options = options ?? {};
            this.format = this.format.bind(this);
        }
        format(value) {
            const n = Number(value);
            const { maximumFractionDigits, minimumFractionDigits, style, currency } = this.#options;
            let text;
            if (maximumFractionDigits !== undefined || minimumFractionDigits !== undefined) {
                const digits = Math.max(minimumFractionDigits ?? 0, Math.min(maximumFractionDigits ?? 20, 20));
                text = n.toFixed(digits);
            } else {
                text = String(Math.round(n * 1000) / 1000);
            }
            const [int, frac] = text.split('.');
            const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            text = frac ? `${grouped}.${frac}` : grouped;
            if (style === 'percent') return `${text}%`;
            if (style === 'currency' && currency) return `${currency} ${text}`;
            return text;
        }
        formatToParts(value) {
            return [{ type: 'literal', value: this.format(value) }];
        }
        resolvedOptions() {
            return { locale: 'en-US', numberingSystem: 'latn', style: 'decimal', ...this.#options };
        }
        static supportedLocalesOf() {
            return ['en-US'];
        }
    }

    class PluralRules {
        constructor(locales, options = {}) {
            this.options = options ?? {};
        }
        select(n) {
            return Number(n) === 1 ? 'one' : 'other';
        }
        resolvedOptions() {
            return { locale: 'en-US', type: 'cardinal', ...this.options };
        }
        static supportedLocalesOf() {
            return ['en-US'];
        }
    }

    class RelativeTimeFormat {
        format(value, unit) {
            const n = Number(value);
            const u = String(unit).replace(/s$/, '');
            const abs = Math.abs(n);
            const label = `${abs} ${u}${abs === 1 ? '' : 's'}`;
            return n < 0 ? `${label} ago` : `in ${label}`;
        }
        static supportedLocalesOf() {
            return ['en-US'];
        }
    }

    class ListFormat {
        constructor(locales, options = {}) {
            this.options = options ?? {};
        }
        format(list) {
            const items = Array.from(list, String);
            const word = this.options.type === 'disjunction' ? 'or' : 'and';
            if (items.length <= 1) return items.join('');
            if (items.length === 2) return `${items[0]} ${word} ${items[1]}`;
            return `${items.slice(0, -1).join(', ')}, ${word} ${items[items.length - 1]}`;
        }
        static supportedLocalesOf() {
            return ['en-US'];
        }
    }

    class Segmenter {
        constructor(locales, options = {}) {
            this.options = { granularity: 'grapheme', ...options };
        }
        segment(input) {
            const text = String(input);
            const granularity = this.options.granularity;
            const regex = granularity === 'word' ? /\w+|\s+|[^\w\s]+/gu : granularity === 'sentence' ? /[^.!?]+[.!?]*\s*/gu : /./gsu;
            const segments = [];
            for (const match of text.matchAll(regex)) {
                const segment = { segment: match[0], index: match.index, input: text };
                if (granularity === 'word') segment.isWordLike = /\w/.test(match[0]);
                segments.push(segment);
            }
            return {
                [Symbol.iterator]: () => segments[Symbol.iterator](),
                containing: (index = 0) => segments.find(s => index >= s.index && index < s.index + s.segment.length),
            };
        }
        static supportedLocalesOf() {
            return ['en-US'];
        }
    }

    class Locale {
        constructor(tag) {
            this.baseName = String(tag);
            this.language = this.baseName.split(/[-_]/)[0];
        }
        toString() {
            return this.baseName;
        }
    }

    define(globalThis, 'Intl', {
        Collator,
        DateTimeFormat,
        NumberFormat,
        PluralRules,
        RelativeTimeFormat,
        ListFormat,
        Segmenter,
        Locale,
        getCanonicalLocales: (locales) => locales === undefined ? [] : [].concat(locales).map(String),
        supportedValuesOf: () => [],
    });
}

// ---------------------------------------------------------------------------
// Regex Unicode property escapes (\p{L}) need ICU in V8. Regex literals are rewritten at
// build time (mobile/build-assets.mjs); this handles patterns built at runtime with
// new RegExp(string, 'u').
// ---------------------------------------------------------------------------
(function patchRegExp() {
    let supported = true;
    try {
        new RegExp('\\p{L}', 'u');
    } catch {
        supported = false;
    }
    let vFlagSupported = true;
    try {
        new RegExp('[a]', 'v');
    } catch {
        vFlagSupported = false;
    }
    if (supported && vFlagSupported) return;

    let rewritePattern;
    try {
        rewritePattern = require('regexpu-core');
    } catch {
        console.warn('[mobile] regexpu-core is not available; dynamic \\p{...} regular expressions will fail');
        return;
    }

    const NativeRegExp = RegExp;
    const cache = new Map();
    const needsRewrite = (pattern, flags) => (!supported && /\\[pP]\{/.test(pattern) && /[uv]/.test(flags)) || (!vFlagSupported && flags.includes('v'));
    const rewrite = (pattern, flags) => {
        const key = flags + '/' + pattern;
        let result = cache.get(key);
        if (!result) {
            const newPattern = rewritePattern(pattern, flags, {
                unicodePropertyEscapes: 'transform',
                unicodeSetsFlag: flags.includes('v') ? 'transform' : false,
            });
            result = [newPattern, flags.replace('v', 'u')];
            if (cache.size > 500) cache.clear();
            cache.set(key, result);
        }
        return result;
    };
    const normalizeArgs = (pattern, flags) => {
        if (pattern instanceof NativeRegExp) {
            const sourceFlags = flags === undefined ? pattern.flags : String(flags);
            if (needsRewrite(pattern.source, sourceFlags)) return rewrite(pattern.source, sourceFlags);
            return [pattern, flags];
        }
        if (typeof pattern === 'string' && flags !== undefined) {
            const f = String(flags);
            if (needsRewrite(pattern, f)) return rewrite(pattern, f);
        }
        return [pattern, flags];
    };

    globalThis.RegExp = new Proxy(NativeRegExp, {
        construct(target, argumentsList, newTarget) {
            const [pattern, flags] = normalizeArgs(argumentsList[0], argumentsList[1]);
            const finalArgs = flags === undefined ? [pattern] : [pattern, flags];
            return Reflect.construct(target, finalArgs, newTarget === globalThis.RegExp ? target : newTarget);
        },
        apply(target, thisArg, argumentsList) {
            const [pattern, flags] = normalizeArgs(argumentsList[0], argumentsList[1]);
            return flags === undefined ? target(pattern) : target(pattern, flags);
        },
    });
})();
