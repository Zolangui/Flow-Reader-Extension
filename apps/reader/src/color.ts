export function rgbFromArgb(argb: number) {
  return [(argb >> 16) & 255, (argb >> 8) & 255, argb & 255]
}

function argbFromRgb(red: number, green: number, blue: number) {
  return (
    ((255 << 24) |
      ((red & 255) << 16) |
      ((green & 255) << 8) |
      (blue & 255)) >>>
    0
  )
}

function hexFromArgb(argb: number) {
  return `#${(argb & 0xffffff).toString(16).padStart(6, '0')}`
}

function compositeChannels(channel1: number, channel2: number, p: number) {
  return (1 - p) * channel1 + p * channel2
}

// https://en.wikipedia.org/wiki/Transparency_%28graphic%29#Compositing_calculations
export function compositeColors(color1: number, color2: number, p: number) {
  const [r1, g1, b1] = rgbFromArgb(color1)
  const [r2, g2, b2] = rgbFromArgb(color2)
  return hexFromArgb(
    argbFromRgb(
      compositeChannels(r1!, r2!, p),
      compositeChannels(g1!, g2!, p),
      compositeChannels(b1!, b2!, p),
    ),
  )
}
