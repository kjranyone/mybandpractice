package com.donoy.mybandpractice.v2.sync

/**
 * `lz-string` 1.4.5 `compressToEncodedURIComponent` /
 * `decompressFromEncodedURIComponent`. The QR handshake uses this alphabet
 * and bit packing, so the output has to match the web client byte for byte.
 */
private const val URI_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$"

private val URI_INDEX: Map<Char, Int> = URI_ALPHABET.withIndex().associate { it.value to it.index }

fun compressToEncodedUriComponent(input: String?): String {
    if (input == null) return ""
    return compress(input, 6, URI_ALPHABET)
}

fun decompressFromEncodedUriComponent(input: String?): String? {
    if (input == null) return ""
    if (input.isEmpty()) return null
    val normalized = input.replace(' ', '+')
    return decompress(normalized.length, 32) { index ->
        if (index < 0 || index >= normalized.length) 0 else URI_INDEX[normalized[index]] ?: 0
    }
}

private class BitPacker(private val bitsPerChar: Int, private val alphabet: String) {
    private val out = StringBuilder()
    private var dataVal = 0
    private var dataPos = 0

    fun writeZero() {
        shift(0)
    }

    fun writeLsb(bitSource: Int): Int {
        shift(bitSource and 1)
        return bitSource shr 1
    }

    fun writeBit(bit: Int) {
        shift(bit and 1)
    }

    fun flush() {
        while (true) {
            dataVal = dataVal shl 1
            if (dataPos == bitsPerChar - 1) {
                out.append(alphabet[dataVal])
                break
            }
            dataPos++
        }
    }

    fun text(): String = out.toString()

    private fun shift(bit: Int) {
        dataVal = (dataVal shl 1) or bit
        if (dataPos == bitsPerChar - 1) {
            dataPos = 0
            out.append(alphabet[dataVal])
            dataVal = 0
        } else {
            dataPos++
        }
    }
}

private fun compress(uncompressed: String, bitsPerChar: Int, alphabet: String): String {
    val dictionary = HashMap<String, Int>()
    val toCreate = HashSet<String>()
    var enlargeIn = 2
    var dictSize = 3
    var numBits = 2
    val packer = BitPacker(bitsPerChar, alphabet)
    var w = ""

    fun grow() {
        enlargeIn--
        if (enlargeIn == 0) {
            enlargeIn = 1 shl numBits
            numBits++
        }
    }

    fun writeNewToken(token: String) {
        val code = token[0].code
        if (code < 256) {
            repeat(numBits) { packer.writeZero() }
            var value = code
            repeat(8) { value = packer.writeLsb(value) }
        } else {
            var marker = 1
            repeat(numBits) {
                packer.writeBit(marker)
                marker = 0
            }
            var value = code
            repeat(16) { value = packer.writeLsb(value) }
        }
        grow()
        toCreate.remove(token)
    }

    fun writeCode(code: Int) {
        var value = code
        repeat(numBits) { value = packer.writeLsb(value) }
    }

    for (i in uncompressed.indices) {
        val c = uncompressed[i].toString()
        if (!dictionary.containsKey(c)) {
            dictionary[c] = dictSize++
            toCreate.add(c)
        }
        val wc = w + c
        if (dictionary.containsKey(wc)) {
            w = wc
        } else {
            if (toCreate.contains(w)) writeNewToken(w) else writeCode(dictionary.getValue(w))
            grow()
            dictionary[wc] = dictSize++
            w = c
        }
    }

    if (w.isNotEmpty()) {
        if (toCreate.contains(w)) writeNewToken(w) else writeCode(dictionary.getValue(w))
        grow()
    }

    var end = 2
    repeat(numBits) { end = packer.writeLsb(end) }
    packer.flush()
    return packer.text()
}

private class BitReader(
    length: Int,
    resetValue: Int,
    private val nextValue: (Int) -> Int,
) {
    private val length = length
    var index = 1
    private var position = resetValue
    private var value = nextValue(0)

    fun pastEnd(): Boolean = index > length

    fun read(numBits: Int): Int {
        var bits = 0
        var power = 1
        val maxPower = 1 shl numBits
        while (power != maxPower) {
            val resb = value and position
            position = position ushr 1
            if (position == 0) {
                position = 32
                value = nextValue(index)
                index++
            }
            bits = bits or ((if (resb > 0) 1 else 0) * power)
            power = power shl 1
        }
        return bits
    }
}

private fun decompress(length: Int, resetValue: Int, nextValue: (Int) -> Int): String? {
    val dictionary = ArrayList<String?>()
    repeat(3) { dictionary.add(null) }
    var enlargeIn = 4
    var dictSize = 4
    var numBits = 3
    val reader = BitReader(length, resetValue, nextValue)
    val result = StringBuilder()

    fun readChar(bits: Int): String {
        var value = 0
        var power = 1
        val maxPower = 1 shl bits
        while (power != maxPower) {
            val resb = reader.read(1)
            value = value or (resb * power)
            power = power shl 1
        }
        return value.toChar().toString()
    }

    val first = when (val marker = reader.read(2)) {
        0 -> readChar(8)
        1 -> readChar(16)
        else -> return ""
    }
    dictionary.add(first)
    var w = first
    result.append(first)

    while (true) {
        if (reader.pastEnd()) return ""
        var c = reader.read(numBits)
        when (c) {
            0 -> {
                val ch = readChar(8)
                while (dictionary.size < dictSize) dictionary.add(null)
                dictionary.add(ch)
                c = dictSize
                dictSize++
                enlargeIn--
            }
            1 -> {
                val ch = readChar(16)
                while (dictionary.size < dictSize) dictionary.add(null)
                dictionary.add(ch)
                c = dictSize
                dictSize++
                enlargeIn--
            }
            2 -> return result.toString()
        }
        if (enlargeIn == 0) {
            enlargeIn = 1 shl numBits
            numBits++
        }
        val entry = when {
            c < dictionary.size && dictionary[c] != null -> dictionary[c]!!
            c == dictSize -> w + w[0]
            else -> return null
        }
        result.append(entry)
        while (dictionary.size < dictSize) dictionary.add(null)
        dictionary.add(w + entry[0])
        dictSize++
        enlargeIn--
        w = entry
        if (enlargeIn == 0) {
            enlargeIn = 1 shl numBits
            numBits++
        }
    }
}
