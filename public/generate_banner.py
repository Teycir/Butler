"""
Butler MCP — README Storyboard Animation Generator
Run: python3 generate_banner.py
Produces butler_banner.gif in the public folder.
"""

from PIL import Image, ImageDraw, ImageFont
import math, os, random

W, H   = 720, 340
FPS    = 30
FRAMES = 120  # 4 seconds at 30fps
OUT    = os.path.join(os.path.dirname(__file__), "butler_banner.gif")

# Color Palette
BG          = (10, 10, 18)
CARD_DARK   = (22, 28, 50)
CARD_MID    = (34, 42, 72)
CARD_BORDER = (60, 80, 160)
GOLD        = (200, 170, 80)
GOLD_DIM    = (120, 100, 45)
WHITE       = (240, 240, 255)
DIM         = (100, 105, 130)
ACCENT_A    = (80, 160, 255)  # Cursor blue
ACCENT_B    = (234, 114, 48)  # Claude orange
ACCENT_C    = (80, 220, 160)  # Green
GLOW_A      = (40, 80, 160)
GLOW_B      = (130, 60, 30)

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
MONO_MD = load_font(12, bold=True)

# Mascot butler drawing
def draw_butler_figure(draw, bx, by, arm_angle, facing_left=True):
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
    
    # Monocle
    if facing_left:
        draw.ellipse([bx-13,by+6,bx-3,by+16], outline=GOLD, width=1)
        draw.line([(bx-13,by+16),(bx-16,by+20)], fill=GOLD, width=1)
    else:
        draw.ellipse([bx+3,by+6,bx+13,by+16], outline=GOLD, width=1)
        draw.line([(bx+13,by+16),(bx+16,by+20)], fill=GOLD, width=1)

    # Arm and Tray
    ax, ay = (bx-20, by+22) if facing_left else (bx+20, by+22)
    arm_len = 38
    ex = int(ax + arm_len * math.cos(math.radians(arm_angle)))
    ey = int(ay + arm_len * math.sin(math.radians(arm_angle)))
    draw.line([(ax,ay),(ex,ey)], fill=suit, width=8)
    draw.ellipse([ex-7,ey-7,ex+7,ey+7], fill=WHITE)
    
    tray_w = 48
    tx = ex - tray_w//2
    ty = ey - 3
    draw.rectangle([tx,ty,tx+tray_w,ty+5], fill=(180,175,160))
    draw.rectangle([tx+2,ty,tx+tray_w-2,ty+2], fill=(210,205,190))
    return ex, ey - 3

def draw_editor_window(draw, x, y, label, accent, glow_color, alpha, active_todos, completed_todos):
    ww, wh = 160, 95
    if alpha <= 0.01: return
    glow_rect(draw, x, y, ww, wh, glow_color, radius=8, intensity=0.25*alpha)
    
    # Background and Border
    bg_col = alpha_blend(BG, CARD_DARK, alpha)
    border_col = alpha_blend(BG, CARD_BORDER, alpha)
    rounded_rect(draw, x, y, ww, wh, 8, bg_col, border_col, 1)
    
    # Header bar
    rounded_rect(draw, x, y, ww, 20, 8, alpha_blend(BG, CARD_MID, alpha))
    draw.rectangle([x, y+12, x+ww, y+20], fill=alpha_blend(BG, CARD_MID, alpha))
    for i, col in enumerate([(220,80,80),(220,180,80),(80,200,100)]):
        col_fade = alpha_blend(BG, col, alpha)
        draw.ellipse([x+8+i*14, y+6, x+14+i*14, y+12], fill=col_fade)
    
    draw.text((x+ww//2, y+10), label, fill=alpha_blend(BG, accent, alpha), anchor="mm", font=MONO_SM)

    # Content
    for i, txt in enumerate(completed_todos):
        col = alpha_blend(BG, (100, 200, 120), alpha)  # green
        draw.text((x+10, y+26+i*14), f"[x] {txt}", fill=col, font=MONO_XS)
        
    for j, txt in enumerate(active_todos):
        col = alpha_blend(BG, DIM, alpha)
        draw.text((x+10, y+26+(len(completed_todos)+j)*14), f"[ ] {txt}", fill=col, font=MONO_XS)

def draw_shared_db(draw, cx, cy):
    # Cylindrical database stack representing Butler SQLite DB
    w, h = 90, 80
    x, y = cx - w//2, cy - h//2
    glow_rect(draw, x, y, w, h, GOLD, radius=6, intensity=0.15)
    
    # Base cylinder rounds
    for i in range(3):
        dy = y + i*24
        rounded_rect(draw, x, dy, w, 20, 6, CARD_DARK, GOLD_DIM, 1)
        # Reflect highlights
        rounded_rect(draw, x+2, dy+2, w-4, 6, 6, CARD_MID)
        # Database lights
        draw.ellipse([x+8, dy+7, x+13, dy+12], fill=ACCENT_C)
        draw.text((x+w//2+4, dy+10), f"PART-{i+1}", fill=DIM, anchor="mm", font=MONO_XS)

def draw_handoff_card(draw, cx, cy, label, color, scale=1.0):
    cw = int(72 * scale)
    ch = int(44 * scale)
    x, y = cx - cw//2, cy - ch//2
    shadow_col = (int(color[0]*0.15), int(color[1]*0.15), int(color[2]*0.15))
    rounded_rect(draw, x+3, y+3, cw, ch, 4, shadow_col)
    bg = blend(CARD_DARK, color, 0.15)
    rounded_rect(draw, x, y, cw, ch, 4, bg, color, 1)
    rounded_rect(draw, x, y, cw, 10, 4, blend(CARD_DARK, color, 0.35))
    draw.rectangle([x, y+6, x+cw, y+10], fill=blend(CARD_DARK, color, 0.35))
    draw.text((x+cw//2, y+24), label, fill=blend(color, WHITE, 0.7), anchor="mm", font=MONO_XS)

def draw_brand(draw, t):
    draw.text((W//2, 24), "Butler Coordination Flow", fill=GOLD, anchor="mm", font=MONO_LG)
    
    # Subtitle with active steps
    step = "1. Active session completes tasks"
    if 0.25 <= t < 0.5:
        step = "2. Session disconnects -> Butler saves handoff"
    elif 0.5 <= t < 0.75:
        step = "3. Peer session registers -> Reads context"
    elif t >= 0.75:
        step = "4. Context rehydrated seamlessly!"
        
    draw.text((W//2, 48), step, fill=ACCENT_C, anchor="mm", font=MONO_MD)

# Floor Grid Scroll
def draw_floor(draw, scroll):
    vp_x, vp_y = W//2, H//2+35
    col = (25, 27, 42)
    for i in range(16):
        lx = int(lerp(0, W, i/15))
        draw.line([(lx,H),(vp_x,vp_y)], fill=col, width=1)
    for i in range(8):
        s = (i + scroll % 1) / 8
        y = int(lerp(vp_y, H, ease_out(s)))
        if y <= vp_y: continue
        xl = int(lerp(vp_x,0,s))
        xr = int(lerp(vp_x,W,s))
        a = int(35*s)
        draw.line([(xl,y),(xr,y)], fill=(a,a+2,a+10), width=1)


frames_out = []
butler_x, butler_y = W//2, 140

for f in range(FRAMES):
    t = f / FRAMES
    img  = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    draw_floor(draw, t*4)
    draw.line([(50,56),(W-50,56)], fill=(32,34,50), width=1)
    
    # Draw Shared Database in Center
    draw_shared_db(draw, W//2, 220)
    
    # Storyboard parameters based on time
    # Phase 1: t in [0.0, 0.3] -> Cursor active, completing tasks
    # Phase 2: t in [0.3, 0.45] -> Cursor disconnects, handoff created
    # Phase 3: t in [0.45, 0.75] -> Claude registers, reads context
    # Phase 4: t in [0.75, 1.0] -> Claude continues work
    
    # 1. Left Editor (Cursor) opacity
    cursor_alpha = 1.0
    if 0.3 <= t < 0.45:
        cursor_alpha = lerp(1.0, 0.0, (t - 0.3) / 0.15)
    elif t >= 0.45:
        cursor_alpha = 0.0
        
    draw_editor_window(
        draw, 40, 120, "Cursor (Session A)", ACCENT_A, GLOW_A, cursor_alpha,
        active_todos=["Task 2", "Task 3"], completed_todos=["Task 1 (Done)"]
    )
    
    # 2. Right Editor (Claude) opacity
    claude_alpha = 0.0
    if 0.45 <= t < 0.6:
        claude_alpha = lerp(0.0, 1.0, (t - 0.45) / 0.15)
    elif t >= 0.6:
        claude_alpha = 1.0
        
    claude_completed = []
    claude_active = ["Task 2", "Task 3"]
    if t >= 0.75:
        claude_completed = ["Task 1", "Task 2 (Working)"]
        claude_active = ["Task 3"]
        
    draw_editor_window(
        draw, W - 200, 120, "Claude (Session B)", ACCENT_B, GLOW_B, claude_alpha,
        active_todos=claude_active, completed_todos=claude_completed
    )

    # Butler Mascot movements
    facing_left = True
    arm_angle = 180  # Default reaching left
    
    if t < 0.3:
        # Reaching left
        arm_angle = 180 - 15 * math.sin(t * math.pi * 3)
    elif 0.3 <= t < 0.45:
        # Pulling back arm, rotating
        turn_progress = (t - 0.3) / 0.15
        arm_angle = lerp(180, 270, turn_progress)
    elif 0.45 <= t < 0.75:
        # Facing right, reaching out
        facing_left = False
        reach_progress = (t - 0.45) / 0.3
        arm_angle = lerp(270, 0, reach_progress)
    else:
        # Steady right
        facing_left = False
        arm_angle = 0 + 5 * math.sin(t * math.pi * 4)

    # Draw Butler and get tray position
    tray_x, tray_y = draw_butler_figure(draw, butler_x, butler_y, arm_angle, facing_left)

    # Draw Flying Handoff Card
    if 0.1 <= t < 0.35:
        # Card floats from Cursor window to Butler's tray
        card_t = (t - 0.1) / 0.25
        cx = int(lerp(120, tray_x, ease_inout(card_t)))
        cy = int(lerp(150, tray_y - 10, ease_inout(card_t)))
        draw_handoff_card(draw, cx, cy, "EVENT_LOG", ACCENT_A, scale=1.0)
    elif 0.35 <= t < 0.48:
        # Handoff card goes down to database
        card_t = (t - 0.35) / 0.13
        cx = int(lerp(tray_x, W//2, ease_inout(card_t)))
        cy = int(lerp(tray_y - 10, 200, ease_inout(card_t)))
        draw_handoff_card(draw, cx, cy, "HANDOFF", GOLD, scale=0.8)
    elif 0.48 <= t < 0.58:
        # Handoff card goes up from database onto Butler's tray
        card_t = (t - 0.48) / 0.10
        cx = int(lerp(W//2, tray_x, ease_inout(card_t)))
        cy = int(lerp(200, tray_y - 10, ease_inout(card_t)))
        draw_handoff_card(draw, cx, cy, "CONTEXT", GOLD, scale=0.8)
    elif 0.58 <= t < 0.75:
        # Card floats from Butler's tray to Claude window
        card_t = (t - 0.58) / 0.17
        cx = int(lerp(tray_x, W - 120, ease_inout(card_t)))
        cy = int(lerp(tray_y - 10, 150, ease_inout(card_t)))
        draw_handoff_card(draw, cx, cy, "REHYDRATED", ACCENT_B, scale=1.0)
        
    draw_brand(draw, t)
    
    # Status bar
    dots = "\u25cf" * (1 + (f // 15) % 3) + "\u25cb" * (3 - (1 + (f // 15) % 3))
    status_text = f"butler-mcp  \u00b7  {dots}  \u00b7  db: butler.db (WAL)  \u00b7  status: synchronized"
    draw.text((W//2, H-12), status_text, fill=DIM, anchor="mm", font=MONO_XS)

    frames_out.append(img)

# Save the compiled GIF
frames_out[0].save(
    OUT,
    save_all=True,
    append_images=frames_out[1:],
    loop=0,
    duration=int(1000/FPS),
    optimize=False,
)
print(f"Successfully generated visual explanatory storyboard: {OUT}")
