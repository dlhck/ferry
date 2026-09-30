/// The most characters of a menu item title. A menu item does not wrap its title, so a longer title makes the menu wider.
let titleLimit = 60

/// Put "…" in place of the middle of a text that has more than `limit` characters.
func cutMiddle(_ text: String, limit: Int = titleLimit) -> String {
    guard text.count > limit else { return text }
    let keep = limit - 1
    return "\(text.prefix((keep + 1) / 2))…\(text.suffix(keep / 2))"
}

/// The words of a text on lines of at most `width` characters. A longer word continues on the next line.
func wrapped(_ text: String, width: Int = titleLimit) -> [String] {
    var lines: [String] = []
    var line = ""
    for var word in text.split(whereSeparator: \.isWhitespace).map(String.init) {
        while word.count > width {
            if !line.isEmpty { lines.append(line) }
            line = ""
            lines.append(String(word.prefix(width)))
            word = String(word.dropFirst(width))
        }
        if line.isEmpty {
            line = word
        } else if line.count + 1 + word.count <= width {
            line += " " + word
        } else {
            lines.append(line)
            line = word
        }
    }
    if !line.isEmpty { lines.append(line) }
    return lines
}
