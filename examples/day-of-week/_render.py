"""Render the day-of-week example: a dense AI-written section (before) and the noro rewrite (after).
All numbers are synthetic. Run: python3 examples/day-of-week/_render.py
"""
import os
import textwrap
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
matplotlib.rcParams["text.parse_math"] = False

HERE = os.path.dirname(os.path.abspath(__file__))
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
JAN_APR = [89, 108, 99, 127, 96, 90, 92]          # cost per conversion, USD
MAY_AUG = [104, 97, 95, 105, 101, 109, 138]
CONV_PER_DAY = [16.4, 15.1, 16.9, 14.2, 13.8, 12.9, 9.6]
OTHER_DAYS = 101

INK, QUIET, GRID, LIGHT, BLUE = "#1f1f1f", "#8a8a8a", "#e6e6e6", "#c9c9c4", "#2f6fd6"
SERIF = "DejaVu Serif"


def para(fig, x, y, text, width, size=12.5, color=INK, family=None):
    fig.text(x, y, textwrap.fill(text, width), fontsize=size, color=color, va="top",
             linespacing=1.55, family=family)


def before():
    fig = plt.figure(figsize=(7.6, 8.0), dpi=150)
    fig.text(0.03, 0.975, "Day-of-week performance", fontsize=19, family=SERIF, color=INK, va="top")
    para(fig, 0.03, 0.915, "Since May, every day except Sunday has run between $95 and $109 per "
         "conversion; Sunday is at $138.", 78)
    fig.text(0.05, 0.835, "Sunday is now the weak day: $138 per conversion since May vs. $101 on other days",
             fontsize=10.5, weight="bold", color=INK, va="top")
    fig.text(0.05, 0.81, "Cost per conversion (USD) by day of week, January–April vs. May–August 2026",
             fontsize=8.5, color=QUIET, va="top")

    ax = fig.add_axes([0.11, 0.335, 0.70, 0.43])
    for i, (a, b) in enumerate(zip(JAN_APR, MAY_AUG)):
        y = len(DAYS) - 1 - i
        sun = DAYS[i] == "Sun"
        ax.plot([a, b], [y, y], color=BLUE if sun else LIGHT, lw=1.6 if sun else 1.2, zorder=1)
        ax.scatter([a], [y], s=60, facecolor="#f2f2ef", edgecolor=LIGHT, zorder=2)
        ax.scatter([b], [y], s=60, color=BLUE if sun else "#bdbdb5", zorder=3)
        ax.text(1.05, y, f"{CONV_PER_DAY[i]:.1f}", transform=ax.get_yaxis_transform(), ha="right",
                va="center", fontsize=9, color=INK)
    ax.text(127, len(DAYS) - 4 + 0.32, "$127", ha="center", fontsize=8.5, color=QUIET)
    ax.text(138, 0.32, "$138", ha="center", fontsize=8.5, color=BLUE)
    ax.axvline(OTHER_DAYS, color="#555", ls=(0, (3, 3)), lw=1)
    ax.text(OTHER_DAYS, len(DAYS) - 0.35, "Other days since May $101", fontsize=8.5, color=INK, ha="left")
    ax.text(1.05, len(DAYS) - 0.35, "Conversions per day, May–Aug", transform=ax.get_yaxis_transform(),
            ha="right", fontsize=8.5, color=INK)
    ax.scatter([], [], s=40, facecolor="#f2f2ef", edgecolor=LIGHT, label="Jan–Apr")
    ax.scatter([], [], s=40, color="#bdbdb5", label="May–Aug")
    ax.legend(loc="upper left", bbox_to_anchor=(-0.13, 1.1), ncol=2, frameon=False, fontsize=8.5,
              handletextpad=0.2, columnspacing=1)
    ax.set_yticks(range(len(DAYS)))
    ax.set_yticklabels(list(reversed(DAYS)), fontsize=9)
    ax.get_yticklabels()[0].set_fontweight("bold")
    ax.set_xlim(78, 152)
    ax.set_ylim(-0.6, len(DAYS) - 0.2)
    ax.set_xticks(range(80, 151, 10))
    ax.set_xticklabels([f"${v}" for v in range(80, 151, 10)], fontsize=8.5, color=INK)
    ax.grid(axis="x", color=GRID, lw=0.8)
    for s in ax.spines.values():
        s.set_visible(False)
    ax.tick_params(length=0)

    para(fig, 0.03, 0.29, "Sunday's conversion rate fell to 9.8% in May–August against 14.1% on other days, "
         "while its CPC ($13.52) stayed in line with the rest of the week. That points to what happens after "
         "the click, such as call handling or availability, rather than ad cost; it is a hypothesis for the "
         "client to confirm. Thursday's January–April gap has closed, and weekends overall take 22% of "
         "spend and 22% of conversions.", 82)
    para(fig, 0.03, 0.075, "[Hour-of-day performance: daypart patterns in spend, conversion and efficiency]",
         82, color=QUIET)
    para(fig, 0.03, 0.035, "[Day × hour hotspots: best and worst specific windows from the heatmap]",
         82, color=QUIET)
    fig.savefig(os.path.join(HERE, "before.png"), facecolor="white")
    plt.close(fig)


def after():
    fig = plt.figure(figsize=(7.6, 4.6), dpi=150)
    fig.text(0.03, 0.955, "Since May, Sunday costs $138 per conversion. Other days: $101.",
             fontsize=15, family=SERIF, color=INK, va="top")
    ax = fig.add_axes([0.10, 0.36, 0.84, 0.48])
    order = list(range(len(DAYS)))
    ys = [len(DAYS) - 1 - i for i in order]
    colors = [BLUE if d == "Sun" else "#cfcfca" for d in DAYS]
    ax.barh(ys, MAY_AUG, color=colors, height=0.62)
    ax.axvline(OTHER_DAYS, color="#555", ls=(0, (3, 3)), lw=1)
    ax.text(OTHER_DAYS + 1.5, len(DAYS) - 0.55, "Other days $101", fontsize=9, color=INK)
    ax.text(138 + 2, 0, "$138", va="center", fontsize=10, color=BLUE, weight="bold")
    ax.set_yticks(ys)
    ax.set_yticklabels(DAYS, fontsize=9.5)
    ax.set_xlim(0, 155)
    ax.set_xticks([0, 50, 100, 150])
    ax.set_xticklabels(["$0", "$50", "$100", "$150"], fontsize=8.5, color=QUIET)
    ax.grid(axis="x", color=GRID, lw=0.8)
    ax.set_axisbelow(True)
    for s in ax.spines.values():
        s.set_visible(False)
    ax.tick_params(length=0)
    fig.text(0.10, 0.905, "Cost per conversion by day, May–August 2026", fontsize=8.5, color=QUIET, va="top")
    para(fig, 0.03, 0.27, "Why: CPC held at $13.52, but Sunday's conversion rate is 9.8% (other days 14.1%). "
         "The problem is likely after the click, not the ad.", 84, size=11.5)
    para(fig, 0.03, 0.12, "Next: ask the client how Sunday calls and bookings are handled.", 84, size=11.5)
    fig.savefig(os.path.join(HERE, "after.png"), facecolor="white")
    plt.close(fig)


if __name__ == "__main__":
    before()
    after()
    print("wrote before.png and after.png")
