"""Render the visual corpus cases (07-10): a sloppy original.png and an honest gold.png for each.

All advertisers and numbers are synthetic. Case 11 is rendered separately and is not touched here.
Run: python3 bench/corpus/_render.py            (all cases)
     python3 bench/corpus/_render.py 08 10      (only those cases)
"""
import os
import sys
import textwrap

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import FancyBboxPatch, Rectangle  # noqa: E402

matplotlib.rcParams["text.parse_math"] = False  # so "$" renders as a dollar sign
matplotlib.rcParams["svg.hashsalt"] = "noro"
matplotlib.rcParams["path.simplify"] = True

HERE = os.path.dirname(os.path.abspath(__file__))

# Gold style: the same tokens as case 11's gold.
INK, QUIET, GRID, BAR, BLUE = "#1f1f1f", "#8a8a8a", "#e6e6e6", "#cfcfca", "#2f6fd6"
SERIF = "DejaVu Serif"


def out(case, name):
    return os.path.join(HERE, case, name)


def para(fig, x, y, text, width, size=11.5, color=INK, **kw):
    fig.text(x, y, textwrap.fill(text, width), fontsize=size, color=color, va="top", linespacing=1.55, **kw)


def clean_axes(ax):
    for s in ax.spines.values():
        s.set_visible(False)
    ax.tick_params(length=0)
    ax.set_axisbelow(True)


def gold_hbar(path, title, subtitle, labels, values, highlight, ticks, tick_fmt, value_label, notes,
              figsize=(7.6, 4.6), ax_rect=(0.30, 0.36, 0.64, 0.46), note_y=0.25, other_labels=None):
    """One horizontal bar chart from zero, one highlighted bar, title states the point."""
    fig = plt.figure(figsize=figsize, dpi=150)
    fig.text(0.03, 0.955, title, fontsize=14, family=SERIF, color=INK, va="top")
    fig.text(ax_rect[0], ax_rect[1] + ax_rect[3] + 0.06, subtitle, fontsize=8.5, color=QUIET, va="top")
    ax = fig.add_axes(ax_rect)
    n = len(labels)
    ys = list(range(n - 1, -1, -1))
    colors = [BLUE if lab == highlight else BAR for lab in labels]
    ax.barh(ys, values, color=colors, height=0.62)
    hi = labels.index(highlight)
    ax.text(values[hi] + ticks[-1] * 0.012, ys[hi], value_label, va="center", fontsize=10, color=BLUE,
            weight="bold")
    for i, text in enumerate(other_labels or []):
        if text and i != hi:
            ax.text(values[i] + ticks[-1] * 0.012, ys[i], text, va="center", fontsize=9.5, color=QUIET)
    ax.set_yticks(ys)
    ax.set_yticklabels(labels, fontsize=9.5)
    ax.set_xlim(0, ticks[-1] * 1.12)
    ax.set_xticks(ticks)
    ax.set_xticklabels([tick_fmt(t) for t in ticks], fontsize=8.5, color=QUIET)
    ax.grid(axis="x", color=GRID, lw=0.8)
    clean_axes(ax)
    y = note_y
    for line in notes:
        para(fig, 0.03, y, line, 92)
        y -= 0.075 * (1 + len(line) // 92)
    fig.savefig(path, facecolor="white")
    plt.close(fig)


def gold_vbar(path, title, subtitle, labels, values, highlight, ticks, tick_fmt, value_label, notes,
              other_labels=None):
    """One vertical bar chart from zero, one highlighted bar, title states the point."""
    fig = plt.figure(figsize=(7.6, 4.4), dpi=150)
    lines = len(textwrap.wrap(title, 64))
    para(fig, 0.03, 0.965, title, 64, size=14, family=SERIF)
    sub_y = 0.965 - 0.085 * lines - 0.015
    fig.text(0.10, sub_y, subtitle, fontsize=8.5, color=QUIET, va="top")
    ax = fig.add_axes([0.10, 0.2, 0.86, sub_y - 0.28])
    xs = list(range(len(labels)))
    colors = [BLUE if lab == highlight else BAR for lab in labels]
    ax.bar(xs, values, color=colors, width=0.62)
    hi = labels.index(highlight)
    ax.text(xs[hi], values[hi] + ticks[-1] * 0.02, value_label, ha="center", fontsize=10, color=BLUE,
            weight="bold")
    for i, text in enumerate(other_labels or []):
        if text and i != hi:
            ax.text(xs[i], values[i] + ticks[-1] * 0.02, text, ha="center", fontsize=9.5, color=QUIET)
    ax.set_xticks(xs)
    ax.set_xticklabels(labels, fontsize=9.5)
    ax.set_ylim(0, ticks[-1] * 1.08)
    ax.set_yticks(ticks)
    ax.set_yticklabels([tick_fmt(t) for t in ticks], fontsize=8.5, color=QUIET)
    ax.grid(axis="y", color=GRID, lw=0.8)
    clean_axes(ax)
    y = 0.095
    for line in notes:
        para(fig, 0.03, y, line, 92)
        y -= 0.07
    fig.savefig(path, facecolor="white")
    plt.close(fig)


# ---------------------------------------------------------------- 07: wall of 12 KPI tiles

TILES_07 = [
    ("Impressions", "184,220"), ("Clicks", "6,912"), ("CTR", "3.75%"), ("Avg. CPC", "$6.84"),
    ("Cost", "$47,280"), ("Conversions", "512"), ("Conv. rate", "7.41%"), ("Cost / conv.", "$92.34"),
    ("Phone calls", "338"), ("Form fills", "174"), ("Search impr. share", "46.2%"),
    ("Optimization score", "91.3%"),
]
TILE_COLORS = ["#e53935", "#fb8c00", "#fdd835", "#43a047", "#00acc1", "#1e88e5", "#5e35b1", "#d81b60",
               "#6d4c41", "#546e7a", "#7cb342", "#8e24aa"]
HIGHLIGHTS_07 = ("Highlights: Great month! The account generated 512 conversions with a healthy 3.75% CTR "
                 "and an optimization score of 91.3%, demonstrating strong overall campaign health. Search "
                 "impression share of 46.2% shows significant room to scale.")


def case07():
    case = "07-dashboard-kpi-wall"
    fig = plt.figure(figsize=(9.6, 6.4), dpi=150, facecolor="#f1f3f4")
    fig.patches.append(Rectangle((0, 0.9), 1, 0.1, transform=fig.transFigure, color="#1a3c6e", zorder=0))
    fig.text(0.025, 0.95, "Northfork Heating & Air  ·  Google Ads Performance Dashboard", color="white",
             fontsize=15, weight="bold", va="center")
    fig.text(0.975, 0.95, "Sep 1, 2026 – Sep 30, 2026  ▾", color="white", fontsize=9.5, va="center", ha="right")
    fig.text(0.975, 0.875, "Last updated Oct 1, 2026", color="#5f6368", fontsize=7.5, va="center", ha="right")
    cols, rows = 4, 3
    w, h, gx, gy = 0.225, 0.2, 0.017, 0.03
    x0, ytop = 0.025, 0.845
    for i, (label, value) in enumerate(TILES_07):
        r, c = divmod(i, cols)
        x = x0 + c * (w + gx)
        y = ytop - (r + 1) * h - r * gy
        fig.patches.append(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.002,rounding_size=0.008",
                                          transform=fig.transFigure, facecolor="white", edgecolor="#dadce0",
                                          lw=0.8, zorder=1))
        fig.patches.append(Rectangle((x, y + h - 0.018), w, 0.018, transform=fig.transFigure,
                                     color=TILE_COLORS[i], zorder=2))
        fig.text(x + 0.015, y + h - 0.05, label, fontsize=9.5, color="#5f6368", va="top", zorder=3)
        fig.text(x + 0.015, y + 0.035, value, fontsize=24, weight="bold", color=TILE_COLORS[i], va="bottom",
                 zorder=3)
    box_y = 0.03
    fig.patches.append(FancyBboxPatch((0.025, box_y), 0.95, 0.105, boxstyle="round,pad=0.002,rounding_size=0.008",
                                      transform=fig.transFigure, facecolor="#e8f0fe", edgecolor="#aecbfa",
                                      lw=0.8))
    fig.text(0.04, box_y + 0.088, textwrap.fill(HIGHLIGHTS_07, 150), fontsize=8.8, color="#174ea6", va="top",
             linespacing=1.5)
    fig.savefig(out(case, "original.png"), facecolor=fig.get_facecolor())
    plt.close(fig)

    gold_hbar(out(case, "gold.png"),
              "September: 512 leads at $92.34 each. 338 were phone calls.",
              "Leads by type, Google Ads, September 2026",
              ["Phone calls", "Form fills"], [338, 174], "Phone calls",
              [0, 100, 200, 300, 400], lambda t: f"{t:,}", "338",
              ["Spend was $47,280. The dashboard showed no earlier period, so nothing here is marked up or down."],
              figsize=(7.6, 3.4), ax_rect=(0.17, 0.38, 0.77, 0.34), note_y=0.21, other_labels=["", "174"])


# ---------------------------------------------------------------- 08: truncated axis + dual axis

MONTHS_08 = ["Apr", "May", "Jun", "Jul", "Aug", "Sep"]
CONV_08 = [412, 418, 405, 421, 409, 433]
CPA_08 = [58.20, 57.40, 59.10, 56.80, 60.30, 55.90]
TEXT_08 = ("Appointment requests surged to 433 in September (+5.9% MoM), the highest in six months, while "
           "CPA dropped sharply to $55.90. The inverse relationship between volume and CPA shows our bidding "
           "strategy is scaling efficiently.")


def case08():
    case = "08-truncated-dual-axis"
    fig = plt.figure(figsize=(9.6, 6.0), dpi=150)
    fig.patches.append(Rectangle((0, 0.9), 1, 0.1, transform=fig.transFigure, color="#0b5394"))
    fig.text(0.03, 0.95, "Conversions & CPA Trend", fontsize=20, weight="bold", color="white", va="center")
    fig.text(0.97, 0.95, "Quarrystone Dental  ·  Google Ads  ·  Apr–Sep 2026", fontsize=9.5, color="#cfe2f3",
             va="center", ha="right")
    ax = fig.add_axes([0.09, 0.27, 0.80, 0.56])
    bars = ax.bar(MONTHS_08, CONV_08, color="#3c78d8", width=0.6, edgecolor="#1c4587", lw=1,
                  label="Appointment requests")
    bars[-1].set_color("#6aa84f")
    for b, v in zip(bars, CONV_08):
        ax.text(b.get_x() + b.get_width() / 2, v + 0.6, f"{v}", ha="center", fontsize=10, weight="bold",
                color="#1c4587")
    ax.set_ylim(380, 440)
    ax.set_ylabel("Appointment requests", fontsize=10, color="#1c4587")
    ax.grid(axis="y", color="#bbbbbb", lw=0.9, ls="--")
    ax.set_axisbelow(True)
    ax2 = ax.twinx()
    ax2.plot(MONTHS_08, CPA_08, color="#e69138", lw=3, marker="o", ms=9, label="CPA")
    for i, v in enumerate(CPA_08):
        ax2.text(i + 0.12, v + 0.45, f"${v:.2f}", ha="left", fontsize=9, color="#b45f06", weight="bold",
                 bbox=dict(boxstyle="round,pad=0.15", facecolor="white", edgecolor="none", alpha=0.85))
    ax2.set_ylim(54, 62)
    ax2.set_ylabel("CPA ($)", fontsize=10, color="#b45f06")
    ax.annotate("Surge! +5.9% MoM", xy=(5, 433), xytext=(3.55, 437.5), fontsize=11, weight="bold",
                color="#38761d", arrowprops=dict(arrowstyle="-|>", color="#38761d", lw=2))
    h1, l1 = ax.get_legend_handles_labels()
    h2, l2 = ax2.get_legend_handles_labels()
    ax.legend(h1 + h2, l1 + l2, loc="upper left", fontsize=9, frameon=True)
    fig.patches.append(FancyBboxPatch((0.03, 0.03), 0.94, 0.13, boxstyle="round,pad=0.004",
                                      transform=fig.transFigure, facecolor="#fff2cc", edgecolor="#f1c232"))
    fig.text(0.045, 0.145, textwrap.fill(TEXT_08, 128), fontsize=9.5, color="#333333", va="top",
             linespacing=1.5)
    fig.savefig(out(case, "original.png"), facecolor="white")
    plt.close(fig)

    gold_vbar(out(case, "gold.png"),
              "September's 433 appointment requests were the highest in six months, up 5.9% on August.",
              "Appointment requests by month, Google Ads, April–September 2026",
              MONTHS_08, CONV_08, "Sep", [0, 100, 200, 300, 400, 500], lambda t: f"{t}", "433",
              ["Cost per request: $55.90 in September, $60.30 in August."],
              other_labels=["", "", "", "", "409", ""])


# ---------------------------------------------------------------- 09: nine-slice pie

SPEND_09 = [
    ("PMax – All Products", 20124, "31.2%"), ("Shopping – Tents & Shelters", 9546, "14.8%"),
    ("Shopping – Footwear", 7805, "12.1%"), ("Search – Brand", 6192, "9.6%"),
    ("Search – NB – Hiking Gear", 5418, "8.4%"), ("Shopping – Apparel", 5096, "7.9%"),
    ("Search – Competitors", 4064, "6.3%"), ("Demand Gen – Prospecting", 3612, "5.6%"),
    ("YouTube – Awareness", 2643, "4.1%"),
]
TEXT_09 = ("PMax continues to be the largest investment area at 31.2% of spend, underscoring its pivotal role "
           "in our full-funnel strategy. YouTube – Awareness, while the smallest slice, is driving upper-funnel "
           "awareness that feeds PMax. Our diversified allocation across nine campaigns ensures a holistic, "
           "balanced approach to growth.")


def case09():
    case = "09-pie-nine-slices"
    fig = plt.figure(figsize=(10.0, 6.4), dpi=150)
    fig.text(0.5, 0.955, "Spend Distribution by Campaign", fontsize=19, weight="bold", ha="center", va="top",
             color="#222222")
    fig.text(0.5, 0.895, "Ridgeplume Outdoor  ·  September 2026  ·  Total spend: $64,500", fontsize=10,
             ha="center", va="top", color="#666666")
    ax = fig.add_axes([0.02, 0.2, 0.52, 0.66])
    names = [n for n, _, _ in SPEND_09]
    vals = [v for _, v, _ in SPEND_09]
    pcts = [p for _, _, p in SPEND_09]
    colors = plt.get_cmap("tab10").colors[:9]
    explode = [0.08] + [0] * 8
    wedges, _ = ax.pie(vals, colors=colors, explode=explode, shadow=True, startangle=90,
                       wedgeprops=dict(edgecolor="white", lw=1.2))
    import math
    for wdg, p in zip(wedges, pcts):
        ang = math.radians((wdg.theta1 + wdg.theta2) / 2)
        r = 0.68
        ax.text(r * math.cos(ang) + wdg.center[0], r * math.sin(ang) + wdg.center[1], p, ha="center",
                va="center", fontsize=9, color="white", weight="bold")
    ax.set_aspect("equal")
    lax = fig.add_axes([0.56, 0.22, 0.42, 0.62])
    lax.axis("off")
    for i, (n, v, p) in enumerate(SPEND_09):
        y = 1 - i * 0.11
        lax.add_patch(Rectangle((0, y - 0.035), 0.05, 0.07, color=colors[i], transform=lax.transAxes))
        lax.text(0.08, y, f"{n}   ${v:,} ({p})", fontsize=10, va="center", transform=lax.transAxes,
                 color="#222222")
    fig.text(0.05, 0.15, textwrap.fill(TEXT_09, 140), fontsize=9.5, color="#333333", va="top",
             linespacing=1.5, style="italic")
    fig.savefig(out(case, "original.png"), facecolor="white")
    plt.close(fig)

    order = sorted(SPEND_09, key=lambda t: -t[1])
    gold_hbar(out(case, "gold.png"),
              "PMax took 31.2% of September's $64,500 ad spend.",
              "Spend by campaign, Google Ads, September 2026",
              [n for n, _, _ in order], [v for _, v, _ in order], "PMax – All Products",
              [0, 5000, 10000, 15000, 20000], lambda t: f"${t // 1000}k" if t else "$0", "$20,124",
              ["Next largest: Shopping – Tents & Shelters at 14.8%. The source shows spend only, not results "
               "by campaign."],
              figsize=(7.6, 5.2), ax_rect=(0.33, 0.24, 0.6, 0.6), note_y=0.13)


# ---------------------------------------------------------------- 10: chart titles are topics

MONTHS_10 = ["Jul", "Aug", "Sep"]
IMPR_10 = [288400, 301200, 344900]
CLICKS_10 = [4120, 4260, 4980]
SPEND_10 = [18400, 19100, 22600]
LEADS_10 = [141, 146, 152]
CPL_10 = [130.50, 130.82, 148.68]
TYPE_10 = [("Search", 302), ("PMax", 98), ("Demand Gen", 39)]
TAKEAWAYS_10 = [
    "Strong quarter: 439 leads generated across all campaign types",
    "Spend scaled efficiently to $22,600 in September",
    "Search remains the primary lead driver",
    "Continued optimization across all campaign types",
]


def case10():
    case = "10-topic-chart-titles"
    fig = plt.figure(figsize=(12.8, 7.2), dpi=120)
    fig.text(0.04, 0.95, "Q3 2026 Google Ads Review", fontsize=24, weight="bold", color="#1b2a41", va="top")
    fig.text(0.04, 0.89, "Gantryline  ·  Jul–Sep 2026", fontsize=11, color="#5c6b7a", va="top")
    fig.patches.append(Rectangle((0.04, 0.845), 0.92, 0.004, transform=fig.transFigure, color="#f28c28"))
    pal = ["#1b2a41", "#f28c28", "#4f9da6", "#c0392b"]

    a1 = fig.add_axes([0.06, 0.5, 0.25, 0.3])
    x = range(3)
    a1.bar([i - 0.2 for i in x], IMPR_10, width=0.4, color=pal[0], label="Impressions")
    a1.bar([i + 0.2 for i in x], CLICKS_10, width=0.4, color=pal[1], label="Clicks")
    a1.set_xticks(list(x))
    a1.set_xticklabels(MONTHS_10)
    a1.set_title("Performance overview", fontsize=12, weight="bold", loc="left")
    a1.legend(fontsize=8, loc="upper left")
    a1.tick_params(labelsize=8)
    for i, v in enumerate(IMPR_10):
        a1.text(i - 0.2, v, f"{v:,}", ha="center", va="bottom", fontsize=7)
    for i, v in enumerate(CLICKS_10):
        a1.text(i + 0.2, v, f"{v:,}", ha="center", va="bottom", fontsize=7)
    a1.set_ylim(0, 400000)

    a2 = fig.add_axes([0.39, 0.5, 0.25, 0.3])
    a2.bar(MONTHS_10, SPEND_10, color=pal[2])
    for i, v in enumerate(SPEND_10):
        a2.text(i, v, f"${v:,}", ha="center", va="bottom", fontsize=8)
    a2.set_title("Spend by month", fontsize=12, weight="bold", loc="left")
    a2.tick_params(labelsize=8)
    a2.set_ylim(0, 26000)

    a3 = fig.add_axes([0.72, 0.5, 0.25, 0.3])
    a3.barh([t for t, _ in TYPE_10][::-1], [v for _, v in TYPE_10][::-1], color=pal[3])
    for i, (_, v) in enumerate(TYPE_10[::-1]):
        a3.text(v + 4, i, f"{v}", va="center", fontsize=8)
    a3.set_title("Leads by campaign type", fontsize=12, weight="bold", loc="left")
    a3.tick_params(labelsize=8)
    a3.set_xlim(0, 350)

    a4 = fig.add_axes([0.06, 0.1, 0.25, 0.3])
    a4.plot(MONTHS_10, CPL_10, color=pal[1], lw=2.5, marker="o")
    for i, v in enumerate(CPL_10):
        a4.text(i, v + 1.0, f"${v:.2f}", ha=["left", "center", "right"][i], fontsize=8)
    a4.set_title("CPL trend", fontsize=12, weight="bold", loc="left")
    a4.tick_params(labelsize=8)
    a4.set_ylim(128, 152)
    a4.set_xlim(-0.15, 2.15)

    fig.patches.append(FancyBboxPatch((0.39, 0.1), 0.58, 0.3, boxstyle="round,pad=0.006",
                                      transform=fig.transFigure, facecolor="#f4f6f8", edgecolor="#d5dbe1"))
    fig.text(0.41, 0.37, "Key takeaways", fontsize=13, weight="bold", color="#1b2a41", va="top")
    for i, t in enumerate(TAKEAWAYS_10):
        fig.text(0.415, 0.31 - i * 0.055, "•  " + t, fontsize=11, color="#333333", va="top")
    fig.savefig(out(case, "original.png"), facecolor="white")
    plt.close(fig)

    gold_vbar(out(case, "gold.png"),
              "Cost per lead rose to $149 in September, from $131 in August.",
              "Cost per lead by month, Google Ads, Q3 2026",
              MONTHS_10, CPL_10, "Sep", [0, 50, 100, 150], lambda t: f"${t}", "$149",
              ["Spend rose to $22,600 from $19,100, while leads rose to 152 from 146."],
              other_labels=["", "$131", ""])


CASES = {"07": case07, "08": case08, "09": case09, "10": case10}

if __name__ == "__main__":
    wanted = sys.argv[1:] or list(CASES)
    for key in wanted:
        CASES[key]()
        print(f"rendered case {key}")
