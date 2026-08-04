$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$code = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;

public class IconCutter {
  public static void Cut(string sheetPath, string outDir, string[] names) {
    using (Bitmap sheet = new Bitmap(sheetPath)) {
      int cw = sheet.Width / 4, ch = sheet.Height / 3;
      for (int i = 0; i < 12; i++) {
        int col = i % 4, row = i / 4;
        using (Bitmap cell = new Bitmap(cw, ch, PixelFormat.Format32bppArgb)) {
          using (Graphics g = Graphics.FromImage(cell)) {
            g.DrawImage(sheet, new Rectangle(0, 0, cw, ch), new Rectangle(col * cw, row * ch, cw, ch), GraphicsUnit.Pixel);
          }
          var rect = new Rectangle(0, 0, cw, ch);
          var data = cell.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
          int len = data.Stride * ch;
          byte[] px = new byte[len];
          System.Runtime.InteropServices.Marshal.Copy(data.Scan0, px, 0, len);
          int minX = cw, minY = ch, maxX = -1, maxY = -1;
          for (int y = 0; y < ch; y++) {
            for (int x = 0; x < cw; x++) {
              int p = y * data.Stride + x * 4;
              byte m = Math.Max(px[p], Math.Max(px[p + 1], px[p + 2]));
              px[p] = 255; px[p + 1] = 255; px[p + 2] = 255; px[p + 3] = m;
              if (m > 24) {
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
              }
            }
          }
          System.Runtime.InteropServices.Marshal.Copy(px, 0, data.Scan0, len);
          cell.UnlockBits(data);
          if (maxX < 0) { cell.Save(System.IO.Path.Combine(outDir, names[i] + ".png"), ImageFormat.Png); continue; }
          int margin = (int)(Math.Max(maxX - minX + 1, maxY - minY + 1) * 0.08);
          int bx = Math.Max(0, minX - margin), by = Math.Max(0, minY - margin);
          int bw = Math.Min(cw - bx, maxX - minX + 1 + margin * 2);
          int bh = Math.Min(ch - by, maxY - minY + 1 + margin * 2);
          int side = Math.Max(bw, bh);
          using (Bitmap sq = new Bitmap(side, side, PixelFormat.Format32bppArgb)) {
            using (Graphics g2 = Graphics.FromImage(sq)) {
              g2.DrawImage(cell, new Rectangle((side - bw) / 2, (side - bh) / 2, bw, bh), new Rectangle(bx, by, bw, bh), GraphicsUnit.Pixel);
            }
            sq.Save(System.IO.Path.Combine(outDir, names[i] + ".png"), ImageFormat.Png);
          }
        }
      }
    }
  }
}
'@
Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing

$outDir = 'D:\ObjectCode\TouchDeck\themes\mono\icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$names = @('mic','zap','hand','clipboard-list','square-dashed','send','corner-down-left','slash','at-sign','copy','clipboard-paste','delete')
[IconCutter]::Cut('D:\ObjectCode\TouchDeck\prototype\icons-gen\sheet.png', $outDir, $names)
Get-ChildItem $outDir | ForEach-Object { Write-Output ($_.Name + ' ' + $_.Length) }
