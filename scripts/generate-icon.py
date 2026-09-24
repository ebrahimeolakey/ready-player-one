"""Draw the original Ready Player One tile mark. Requires Pillow."""
from PIL import Image, ImageDraw
from pathlib import Path
root=Path(__file__).resolve().parent.parent
size=1024
im=Image.new('RGBA',(size,size))
d=ImageDraw.Draw(im)
d.rounded_rectangle((64,64,960,960),radius=206,fill='#16281e',outline='#496653',width=6)
mark=Image.new('RGBA',(650,650))
m=ImageDraw.Draw(mark)
for box,color in [((60,60,310,310),'#b8efd6'),((340,60,590,310),'#8dc9af'),((60,340,310,590),'#73a88f'),((340,340,590,590),'#ceeede')]:
    m.rounded_rectangle(box,radius=43,fill=color)
mark=mark.rotate(8,Image.Resampling.BICUBIC,expand=False)
im.alpha_composite(mark,(187,187))
im.save(root/'assets/icon.png')
