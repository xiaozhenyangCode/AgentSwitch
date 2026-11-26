import Foundation
import CoreGraphics
import ImageIO
import WebKit

struct IconError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

@main
struct IconTool {
    private static let size = 1024
    private static let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

    @MainActor
    static func main() async throws {
        let args = CommandLine.arguments
        guard args.count == 4 else {
            throw IconError("Usage: render-icon render <svg> <png> | validate <full-bleed PNG> <Dock PNG>")
        }
        switch args[1] {
        case "render":
            try await render(input: args[2], output: args[3])
        case "validate":
            try validate(fullBleed: args[2], dock: args[3])
        default:
            throw IconError("Unknown icon tool command: \(args[1])")
        }
    }

    @MainActor
    private static func render(input: String, output: String) async throws {
        let svg = try Data(contentsOf: URL(fileURLWithPath: input))
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: size, height: size))
        // Export the canvas directly so page/window backgrounds never flatten SVG alpha.
        let value = try await webView.callAsyncJavaScript(
            """
            const icon = new Image()
            icon.src = svg
            await icon.decode()
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = size
            canvas.getContext('2d', { colorSpace: 'srgb' }).drawImage(icon, 0, 0, size, size)
            return canvas.toDataURL('image/png').split(',')[1]
            """,
            arguments: ["svg": "data:image/svg+xml;base64," + svg.base64EncodedString(), "size": size],
            in: nil,
            contentWorld: .page
        )
        guard let encoded = value as? String, let png = Data(base64Encoded: encoded) else {
            throw IconError("WebKit failed to export \(input)")
        }
        try png.write(to: URL(fileURLWithPath: output))
    }

    private static func image(at path: String) throws -> CGImage {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              image.width == size, image.height == size else {
            throw IconError("Expected a \(size) × \(size) image at \(path)")
        }
        return image
    }

    private static func rgba(_ image: CGImage, x: Int, y: Int) throws -> [UInt8] {
        var channels = [UInt8](repeating: 0, count: 4)
        try channels.withUnsafeMutableBytes { buffer in
            guard let pixel = image.cropping(to: CGRect(x: x, y: y, width: 1, height: 1)),
                  let context = CGContext(
                    data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                    space: sRGB, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                  ) else { throw IconError("Could not sample pixel (\(x), \(y))") }
            context.setBlendMode(.copy)
            context.draw(pixel, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        }
        return channels
    }

    private static func validate(fullBleed: String, dock: String) throws {
        let icon = try image(at: fullBleed)
        let dockIcon = try image(at: dock)
        guard [.premultipliedFirst, .premultipliedLast, .first, .last].contains(dockIcon.alphaInfo) else {
            throw IconError("The Dock PNG must have an alpha channel")
        }
        for y in [0, size - 1] {
            for x in [0, size - 1] {
                let expected = y == 0 ? [247, 248, 250, 255] : [192, 195, 200, 255]
                let actual = try rgba(icon, x: x, y: y)
                // Allow one RGB value of rounding from WebKit and ColorSync conversion.
                guard actual[3] == 255, zip(actual, expected).allSatisfy({ abs(Int($0.0) - $0.1) <= 1 }) else {
                    throw IconError("ICNS gradient corner (\(x), \(y)) is \(actual), expected \(expected)")
                }
                guard try rgba(dockIcon, x: x, y: y) == [0, 0, 0, 0] else {
                    throw IconError("Dock PNG corner (\(x), \(y)) is not transparent")
                }
            }
        }
    }
}
