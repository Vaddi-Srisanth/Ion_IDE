import AppKit

let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> CGColor {
    CGColor(red: red, green: green, blue: blue, alpha: 1)
}

func polygon(_ context: CGContext, _ points: [CGPoint], _ fill: CGColor) {
    context.beginPath()
    context.addLines(between: points)
    context.closePath()
    context.setFillColor(fill)
    context.fillPath()
}

func render(_ pixels: Int) -> Data {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8,
                            bytesPerRow: 0, space: space,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let scale = CGFloat(pixels) / 1024
    context.scaleBy(x: scale, y: scale)

    let tile = CGPath(roundedRect: CGRect(x: 94, y: 94, width: 836, height: 836),
                      cornerWidth: 187, cornerHeight: 187, transform: nil)
    context.saveGState()
    context.addPath(tile)
    context.clip()
    context.setFillColor(color(0.043, 0.073, 0.115))
    context.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
    polygon(context, [CGPoint(x: 125, y: 930), CGPoint(x: 930, y: 930), CGPoint(x: 930, y: 125)],
            color(0.063, 0.112, 0.15))
    context.restoreGState()

    context.addPath(tile)
    context.setStrokeColor(color(0.17, 0.28, 0.35))
    context.setLineWidth(9)
    context.strokePath()

    polygon(context, [CGPoint(x: 267, y: 292), CGPoint(x: 485, y: 730),
                      CGPoint(x: 615, y: 730), CGPoint(x: 397, y: 292)], color(0.34, 0.96, 0.88))
    polygon(context, [CGPoint(x: 492, y: 292), CGPoint(x: 710, y: 730),
                      CGPoint(x: 789, y: 730), CGPoint(x: 571, y: 292)], color(0.18, 0.75, 0.79))
    context.setFillColor(color(0.74, 1, 0.97))
    context.fillEllipse(in: CGRect(x: 754, y: 292, width: 46, height: 46))

    return NSBitmapImageRep(cgImage: context.makeImage()!).representation(using: .png, properties: [:])!
}

for size in [16, 32, 128, 256, 512] {
    try render(size).write(to: directory.appendingPathComponent("icon_\(size)x\(size).png"))
    try render(size * 2).write(to: directory.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
