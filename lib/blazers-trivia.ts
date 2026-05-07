/**
 * lib/blazers-trivia.ts
 *
 * Registry of Portland Trail Blazers fun facts, milestones, and Bill
 * Schonely catchphrases. Reference material paying homage to Trail
 * Blazers history — curated as fun facts, not as branding. Tree-shakable
 * and side-effect-free; no React, no DOM, no UI wiring. Intended for
 * future use in a "Did you know?" copy slot, hover tooltips, or
 * loading-screen rotators.
 */

export type BlazersTriviaItem = {
  id: string;
  category: "moment" | "milestone" | "quote" | "lore" | "person";
  text: string;
  year?: number;
  source?: string;
};

export const TRIVIA: readonly BlazersTriviaItem[] = [
  {
    id: "rip-city-origin",
    category: "moment",
    text: "Rip City was born February 18, 1971, when broadcaster Bill Schonely improvised the phrase against the Lakers after guard Jim Barnett tied the game with a long jumper.",
    year: 1971,
  },
  {
    id: "1977-championship",
    category: "milestone",
    text: "Portland's only NBA title came in 1977, when the Blazers fell behind Philadelphia 0-2 in the Finals before winning four straight to claim the championship in six games.",
    year: 1977,
  },
  {
    id: "walton-bicycle-parade",
    category: "lore",
    text: "Bill Walton famously rode his bicycle to the 1977 championship parade, treating the celebration like just another Portland commute.",
    year: 1977,
  },
  {
    id: "walton-named-luke-after-lucas",
    category: "person",
    text: "Bill Walton named his son Luke in honor of teammate Maurice Lucas, the enforcer whose toughness defined the 1977 championship run.",
  },
  {
    id: "lucas-dawkins-brawl",
    category: "moment",
    text: "The 1977 Finals turned in Game 2 when Maurice Lucas confronted Philadelphia's Darryl Dawkins in a brawl, refusing to let the 76ers intimidate Portland.",
    year: 1977,
  },
  {
    id: "814-game-sellout-streak",
    category: "milestone",
    text: "Portland's 814-game sellout streak began April 8, 1977 and ran until 1995, the longest in major American professional sports at the time.",
    year: 1977,
  },
  {
    id: "memorial-coliseum-glass-palace",
    category: "lore",
    text: "Memorial Coliseum was known as the Glass Palace, and during Blazermania its deafening crowd functioned as a sixth man on the floor.",
  },
  {
    id: "lillard-09-second-buzzer-houston",
    category: "moment",
    text: "Damian Lillard's 0.9-second buzzer-beater over Houston in 2014 ended the series and prompted him to grab a courtside mic and shout Rip City.",
    year: 2014,
  },
  {
    id: "lillard-37-foot-dagger-okc",
    category: "moment",
    text: "Damian Lillard's 37-foot dagger over Paul George in 2019 closed out the Thunder, punctuated by a cool, slow wave goodbye to OKC's bench.",
    year: 2019,
  },
  {
    id: "lillard-50-okc-closeout",
    category: "moment",
    text: "Damian Lillard dropped 50 points in the 2019 closeout game against Oklahoma City, capping the series with one of the great playoff sendoffs.",
    year: 2019,
  },
  {
    id: "roy-18-fourth-quarter-dallas",
    category: "moment",
    text: "Brandon Roy scored 18 points in the fourth quarter against Dallas in the 2011 playoffs, the largest fourth-quarter playoff comeback in franchise history.",
    year: 2011,
  },
  {
    id: "roy-52-points-phoenix",
    category: "moment",
    text: "Brandon Roy poured in 52 points against Phoenix in December 2008, the highest-scoring single game of his career in Portland.",
    year: 2008,
  },
  {
    id: "drexler-the-glide",
    category: "person",
    text: "Clyde Drexler earned the nickname The Glide, though late-80s first-round exits briefly drew the mocking Clyde the Slide before he silenced critics in 1990.",
  },
  {
    id: "drexler-drive-street",
    category: "lore",
    text: "The city of Portland honored Clyde Drexler by naming a street Drexler Drive near the arena, a permanent fixture of his Rip City legacy.",
  },
  {
    id: "ramsay-77-retired",
    category: "milestone",
    text: "Jack Ramsay's number 77 hangs in the rafters honoring the 1977 championship year, the only retired number in franchise history tied to a season rather than a jersey.",
  },
  {
    id: "schonely-mic-retired",
    category: "lore",
    text: "Bill Schonely never wore a jersey number, so the franchise symbolically retired his microphone — a fitting tribute to the voice of Rip City for half a century.",
  },
  {
    id: "wallace-41-techs",
    category: "milestone",
    text: "Rasheed Wallace set the NBA record with 41 technical fouls in 77 games during the 2000-01 season, a single-season mark that still stands.",
    year: 2001,
  },
  {
    id: "rip-city-statue",
    category: "lore",
    text: "The Rip City statue outside Moda Center is missing the second I on purpose, leaving a gap where fans can stand and become part of the phrase.",
  },
  {
    id: "rip-city-jersey",
    category: "lore",
    text: "The Rip City jersey is the only NBA uniform on which neither the city nor the team name appears — just the rallying cry itself.",
  },
  {
    id: "lillard-zero-oakland-ogden-oregon",
    category: "person",
    text: "Damian Lillard wore number 0 to represent the O in Oakland, Ogden, and Oregon — the three places that shaped his journey to the NBA.",
  },
  {
    id: "early-90s-core-five",
    category: "lore",
    text: "Portland's early-90s Finals teams ran on a five-man core of Clyde Drexler, Terry Porter, Jerome Kersey, Kevin Duckworth, and Buck Williams.",
  },
  {
    id: "walton-schonely-hof-tribute",
    category: "person",
    text: "At his Hall of Fame induction, Bill Walton called Bill Schonely the most important figure in the history of Oregon sports.",
  },
  {
    id: "schonely-rip-city-quote",
    category: "quote",
    text: "Rip City, all right!",
    year: 1971,
    source: "Bill Schonely, Feb 18 1971",
  },
  {
    id: "schonely-free-throws-quote",
    category: "quote",
    text: "You've got to make your free throws.",
    source: "Bill Schonely",
  },
  {
    id: "wallace-ball-dont-lie",
    category: "quote",
    text: "Ball don't lie.",
    source: "Rasheed Wallace",
  },
  {
    id: "batum-trust-roy",
    category: "quote",
    text: "You still Brandon Roy, we trust you.",
    year: 2011,
    source: "Nicolas Batum, 2011 playoffs Game 4",
  },
  {
    id: "schonely-bingo-bango-bongo",
    category: "quote",
    text: "Bingo bango bongo.",
    source: "Bill Schonely",
  },
  {
    id: "schonely-golden-ladder",
    category: "quote",
    text: "Climb the golden ladder.",
    source: "Bill Schonely",
  },
  {
    id: "schonely-lickety-brindle",
    category: "quote",
    text: "Lickety brindle up the middle.",
    source: "Bill Schonely",
  },
];

export function pickRandomTrivia(): BlazersTriviaItem {
  return TRIVIA[Math.floor(Math.random() * TRIVIA.length)];
}

export function pickRandomByCategory(
  category: BlazersTriviaItem["category"]
): BlazersTriviaItem | undefined {
  const pool = TRIVIA.filter((item) => item.category === category);
  if (pool.length === 0) return undefined;
  return pool[Math.floor(Math.random() * pool.length)];
}
