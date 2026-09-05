#!/usr/bin/env swift
// Usage: swift scripts/render-og.swift <template.html> <output.png>

import AppKit
import WebKit

let width = 1200
let height = 630

let args = CommandLine.arguments
guard args.count == 3 else {
    FileHandle.standardError.write("Usage: render-og.swift <template.html> <output.png>\n".data(using: .utf8)!)
    exit(2)
}

let input = URL(fileURLWithPath: args[1]).standardizedFileURL
let output = URL(fileURLWithPath: args[2]).standardizedFileURL

final class Renderer: NSObject, WKNavigationDelegate {
    let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height))

    func start() {
        webView.navigationDelegate = self
        webView.loadFileURL(input, allowingReadAccessTo: input.deletingLastPathComponent())
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("document.fonts.ready.then(() => Promise.all([...document.images].map((img) => img.decode())))") { _, _ in
            let config = WKSnapshotConfiguration()
            config.rect = NSRect(x: 0, y: 0, width: width, height: height)
            webView.takeSnapshot(with: config) { image, error in
                guard let image else { fail(error?.localizedDescription ?? "snapshot failed") }
                write(image)
                exit(0)
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail(error.localizedDescription)
    }
}

func write(_ image: NSImage) {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    rep.size = NSSize(width: width, height: height)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    image.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
    NSGraphicsContext.restoreGraphicsState()

    do {
        try rep.representation(using: .png, properties: [:])!.write(to: output)
        print("Wrote \(output.path) (\(width)x\(height))")
    } catch {
        fail(error.localizedDescription)
    }
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write("render-og: \(message)\n".data(using: .utf8)!)
    exit(1)
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let renderer = Renderer()
renderer.start()
app.run()
