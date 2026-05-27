"""
Butler MCP — README Animation Generator
Run: python3 generate_banner.py
Produces butler_banner.gif in the repo root.
"""

from PIL import Image, ImageDraw, ImageFont
import math, os, random

W, H   = 720, 340
FPS    = 30
FRAMES = 90
OUT    = os.path.join(os.path.dirname(__file__), "butler_banner.gif")

BG          = (10, 10, 18)
CARD_DARK   = (22, 28, 50)
CARD_MID    = (34, 42, 72)
CARD_BORDER = (60, 80, 160)
GOLD        = (200, 170, 80)
GOLD_DIM    = (120, 100, 45)
WHITE       = (240, 240, 255)
DIM         = (100, 105, 130)
ACCENT_A    = (80, 160, 255)
ACCENT_B    = (80, 220, 160)
ACCENT_C    = (220, 120, 80)
GLOW_A      = (40, 80, 160)
GLOW_B      = (40, 120, 80)
GLOW_C      = (130, 60, 30)


def lerp(a, b, t): return a + (b - a) * t
def ease_inout(t): return t * t * (3 - 2 * t)
def ease_out(t): return 1 - (1 - t) ** 3
def blend(c1, c2, t): return tuple(int(lerp(c1[i], c2[i], t)) for i in range(3))
def alpha_blend(base, color, alpha):
    return tuple(int(base[i] * (1 - alpha) + color[i] * alpha) for i in range(3))

def glow_rect(draw, x, y, w, h, color, radius=8, intensity=0.35):
    steps = 12
    for i in range(steps, 0, -1):
        a = intensity * (i / steps) ** 2
        pad = (steps - i) * 4
        r = (int(color[0]*a), int(color[1]*a), int(color[2]*a))
        draw.rounded_rectangle([x-pad, y-pad, x+w+pad, y+h+pad],
                                radius=radius+pad, fill=r)

def rounded_rect(draw, x, y, w, h, radius, fill, outline=None, width=1):
    draw.rounded_rectangle([x, y, x+w, y+h], radius=radius,
                            fill=fill, outline=outline, width=width)

def draw_agent_window(draw, cx, cy, label, accent, glow_color, pulse):
    ww, wh = 130, 78
    x, y = cx - ww//2, cy - wh//2
    glow_rect(draw, x, y, ww, wh, glow_color, radius=8, intensity=0.3+0.12*pulse)
    rounded_rect(draw, x, y, ww, wh, 8, CARD_DARK, CARD_BORDER, 1)
    rounded_rect(draw, x, y, ww, 22, 8, CARD_MID)
    draw.rectangle([x, y+14, x+ww, y+22], fill=CARD_MID)
    for i, col in enumerate([(220,80,80),(220,180,80),(80,200,100)]):
        draw.ellipse([x+8+i*18, y+6, x+16+i*18, y+14], fill=col)
    draw.text((x+ww//2, y+12), label, fill=accent, anchor="mm", font=MONO_SM)
    for row, txt in enumerate(["$ butler connect", "  \u2713 session alive", "  > heartbeat \u2026"]):
        col = blend(DIM, accent, 0.2+0.15*row)
        draw.text((x+8, y+28+row*15), txt, fill=col, font=MONO_XS)
    return x, y, ww, wh

def draw_memory_card(draw, cx, cy, label, color):
    cw, ch = 80, 52
    x, y = cx - cw//2, cy - ch//2
    shadow_col = (int(color[0]*0.15), int(color[1]*0.15), int(color[2]*0.15))
    rounded_rect(draw, x+4, y+4, cw, ch, 6, shadow_col)
    bg = blend(CARD_DARK, color, 0.15)
    rounded_rect(draw, x, y, cw, ch, 6, bg, color, 1)
    rounded_rect(draw, x, y, cw, 14, 6, blend(CARD_DARK, color, 0.35))
    draw.rectangle([x, y+8, x+cw, y+14], fill=blend(CARD_DARK, color, 0.35))
    draw.ellipse([x+6, y+4, x+14, y+12], fill=blend(color, WHITE, 0.5))
    draw.text((x+cw//2, y+26), label, fill=blend(color, WHITE, 0.7),
              anchor="mm", font=MONO_XS)
    for i in range(2):
        lw = int(cw*(0.5+0.2*(i%2)))
        lx = x+(cw-lw)//2
        draw.rectangle([lx, y+37+i*6, lx+lw, y+39+i*6],
                        fill=blend(CARD_MID, color, 0.4))


def draw_butler_figure(draw, bx, by, arm_angle):
    suit = (30, 32, 48)
    draw.polygon([(bx-18,by+20),(bx+18,by+20),(bx+14,by+72),(bx-14,by+72)], fill=suit)
    draw.polygon([(bx-3,by+20),(bx,by+42),(bx-14,by+52),(bx-16,by+20)], fill=WHITE)
    draw.polygon([(bx+3,by+20),(bx,by+42),(bx+14,by+52),(bx+16,by+20)], fill=WHITE)
    draw.polygon([(bx-3,by+22),(bx+3,by+22),(bx+2,by+48),(bx,by+52),(bx-2,by+48)], fill=GOLD)
    draw.ellipse([bx-24,by+14,bx-8,by+30], fill=suit)
    draw.ellipse([bx+8,by+14,bx+24,by+30], fill=suit)
    draw.rectangle([bx-12,by+72,bx-3,by+110], fill=suit)
    draw.rectangle([bx+3,by+72,bx+12,by+110], fill=suit)
    draw.ellipse([bx-16,by+104,bx,by+116], fill=(15,15,22))
    draw.ellipse([bx,by+104,bx+16,by+116], fill=(15,15,22))
    skin = (210,175,130)
    draw.ellipse([bx-14,by-2,bx+14,by+22], fill=skin)
    hat = (20,20,30)
    draw.rectangle([bx-16,by-28,bx+16,by+2], fill=hat)
    draw.rectangle([bx-22,by-2,bx+22,by+4], fill=hat)
    draw.rectangle([bx-16,by-10,bx+16,by-4], fill=GOLD_DIM)
    draw.ellipse([bx+3,by+6,bx+13,by+16], outline=GOLD, width=1)
    draw.line([(bx+13,by+16),(bx+16,by+20)], fill=GOLD, width=1)
    ax, ay = bx+20, by+22
    arm_len = 42
    ex = int(ax + arm_len * math.cos(math.radians(arm_angle)))
    ey = int(ay + arm_len * math.sin(math.radians(arm_angle)))
    draw.line([(ax,ay),(ex,ey)], fill=suit, width=8)
    draw.ellipse([ex-7,ey-7,ex+7,ey+7], fill=WHITE)
    tray_w = 52
    tx = ex - tray_w//2
    ty = ey - 3
    draw.rectangle([tx,ty,tx+tray_w,ty+6], fill=(180,175,160))
    draw.rectangle([tx+2,ty,tx+tray_w-2,ty+2], fill=(210,205,190))
    return ex, ey - 3

def load_font(size, bold=False):
    candidates = [
        f"/usr/share/fonts/truetype/dejavu/DejaVuSansMono{'-Bold' if bold else ''}.ttf",
        f"/usr/share/fonts/truetype/liberation/LiberationMono{'-Bold' if bold else '-Regular'}.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

MONO_SM = load_font(10)
MONO_XS = load_font(9)
MONO_LG = load_font(18, bold=True)
MONO_MD = load_font(13)


random.seed(42)

class Particle:
    def __init__(self):
        self.reset()
    def reset(self):
        self.x = random.uniform(50, W-50)
        self.y = random.uniform(H*0.1, H*0.85)
        self.life = random.uniform(0, 1)
        self.speed = random.uniform(0.004, 0.012)
        self.color = random.choice([ACCENT_A, ACCENT_B, ACCENT_C, GOLD])
        self.size = random.choice([1,1,2])
    def step(self):
        self.life += self.speed
        self.y -= 0.4
        if self.life >= 1: self.reset()
    def draw(self, draw):
        a = math.sin(self.life * math.pi)
        c = alpha_blend(BG, self.color, a * 0.5)
        r = self.size
        draw.ellipse([self.x-r, self.y-r, self.x+r, self.y+r], fill=c)

particles = [Particle() for _ in range(55)]

AGENT_POSITIONS = [
    (130, 130, "Session A", ACCENT_A, GLOW_A),
    (360, 80,  "Session B", ACCENT_B, GLOW_B),
    (590, 130, "Session C", ACCENT_C, GLOW_C),
]
CARD_OFFSETS = [0.0, 0.33, 0.66]
CARD_TYPES   = ["memory", "todo", "rule"]

def flying_card_pos(t, sx, sy, ex, ey):
    mid_x = (sx+ex)/2
    mid_y = min(sy,ey) - 70
    bx = (1-t)**2*sx + 2*(1-t)*t*mid_x + t**2*ex
    by = (1-t)**2*sy + 2*(1-t)*t*mid_y + t**2*ey
    return int(bx), int(by)

def draw_floor(draw, scroll):
    vp_x, vp_y = W//2, H//2+30
    col = (30, 32, 52)
    for i in range(14):
        lx = int(lerp(0, W, i/13))
        draw.line([(lx,H),(vp_x,vp_y)], fill=col, width=1)
    for i in range(10):
        s = (i + scroll % 1) / 10
        y = int(lerp(vp_y, H, ease_out(s)))
        if y <= vp_y: continue
        xl = int(lerp(vp_x,0,s))
        xr = int(lerp(vp_x,W,s))
        a = int(40*s)
        draw.line([(xl,y),(xr,y)], fill=(a,a+2,a+12), width=1)

def draw_brand(draw, t):
    shimmer = 0.5 + 0.5*math.sin(t*2*math.pi*2)
    title_col = blend(GOLD_DIM, GOLD, shimmer)
    draw.text((W//2, 28), "Butler", fill=title_col, anchor="mm", font=MONO_LG)
    draw.text((W//2, 48), "persistent multi-agent memory  \u00b7  mcp server",
              fill=DIM, anchor="mm", font=MONO_SM)

def draw_status(draw, frame):
    dots = "\u25cf"*(1+(frame//12)%3) + "\u25cb"*(3-(1+(frame//12)%3))
    txt = f"butler-mcp  \u00b7  {dots}  \u00b7  3 sessions alive  \u00b7  events: {frame*7+100}"
    draw.text((W//2, H-12), txt, fill=blend(BG, DIM, 0.8), anchor="mm", font=MONO_XS)


frames_out = []
butler_x, butler_y = W//2 - 10, 155

for f in range(FRAMES):
    t = f / FRAMES
    img  = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    draw_floor(draw, t*3)

    for p in particles:
        p.step()
        p.draw(draw)

    draw.line([(60,58),(W-60,58)], fill=(40,42,65), width=1)

    arm_angle = -30 + 12*math.sin(t*2*math.pi)
    tray_cx, tray_ty = draw_butler_figure(draw, butler_x, butler_y, arm_angle)

    for idx, (ax, ay, label, accent, glow) in enumerate(AGENT_POSITIONS):
        pulse = 0.5 + 0.5*math.sin((t+idx*0.25)*2*math.pi)
        draw_agent_window(draw, ax, ay, label, accent, glow, pulse)

        card_t_raw = (t + CARD_OFFSETS[idx]) % 1.0
        flight_t = (card_t_raw - 0.05) / 0.50
        if 0.0 <= flight_t <= 1.0:
            ease_ft = ease_inout(flight_t)
            cx, cy = flying_card_pos(ease_ft, tray_cx, tray_ty, ax, ay+40)
            draw_memory_card(draw, cx, cy, CARD_TYPES[idx], accent)

    draw_brand(draw, t)
    draw_status(draw, f)
    frames_out.append(img)

frames_out[0].save(
    OUT,
    save_all=True,
    append_images=frames_out[1:],
    loop=0,
    duration=int(1000/FPS),
    optimize=False,
)
print(f"Saved {OUT}")
