// Generates build/icon-1024.png: dark rounded square with an amber prompt
// glyph — the app icon, drawn to match the in-app theme.
// Compile+run via scripts/make-icon.sh.
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

int main(void) {
  @autoreleasepool {
    CGFloat S = 1024;
    NSImage* img = [[NSImage alloc] initWithSize:NSMakeSize(S, S)];
    [img lockFocus];

    // macOS icon grid: content square with generous margin
    NSBezierPath* bg = [NSBezierPath bezierPathWithRoundedRect:NSMakeRect(100, 100, 824, 824)
                                                       xRadius:185
                                                       yRadius:185];
    [[NSColor colorWithSRGBRed:0.039 green:0.039 blue:0.043 alpha:1] setFill];
    [bg fill];
    [[NSColor colorWithSRGBRed:0.21 green:0.21 blue:0.23 alpha:1] setStroke];
    [bg setLineWidth:8];
    [bg stroke];

    NSFont* font = [NSFont monospacedSystemFontOfSize:430 weight:NSFontWeightBold];
    [@"❯" drawAtPoint:NSMakePoint(255, 300)
        withAttributes:@{
          NSFontAttributeName : font,
          NSForegroundColorAttributeName :
              [NSColor colorWithSRGBRed:0.886 green:0.698 blue:0.353 alpha:1]
        }];
    [@"_" drawAtPoint:NSMakePoint(530, 330)
        withAttributes:@{
          NSFontAttributeName : font,
          NSForegroundColorAttributeName :
              [NSColor colorWithSRGBRed:0.91 green:0.91 blue:0.92 alpha:1]
        }];

    [img unlockFocus];

    CGImageRef cg = [img CGImageForProposedRect:NULL context:nil hints:nil];
    NSBitmapImageRep* rep = [[NSBitmapImageRep alloc] initWithCGImage:cg];
    rep.size = img.size;
    NSData* png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (![png writeToFile:@"build/icon-1024.png" atomically:YES]) {
      fprintf(stderr, "failed to write png\n");
      return 1;
    }
  }
  return 0;
}
