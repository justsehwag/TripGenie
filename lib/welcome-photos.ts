export interface WelcomePhoto {
  id: string;
  src: string; // "/welcome/<file>"
  alt: string;
  place: string;
  photographer: string;
  photographerUrl: string;
  sourceUrl: string;
  licence: "Unsplash License" | "Pexels License";
}

export const WELCOME_PHOTOS: readonly WelcomePhoto[] = [
  {
    id: "dolomites-tre-cime",
    src: "/welcome/dolomites-tre-cime.webp",
    alt: "Jagged Tre Cime peaks above a winding mountain road and green alpine meadows",
    place: "Tre Cime di Lavaredo, Dolomites, Italy",
    photographer: "Jordi De smedt",
    photographerUrl: "https://www.pexels.com/@jordi-de-smedt-765443169/",
    sourceUrl: "https://www.pexels.com/photo/landscape-of-dolomites-18781953/",
    licence: "Pexels License",
  },
  {
    id: "spiti-valley",
    src: "/welcome/spiti-valley.webp",
    alt: "Snow-streaked Himalayan peak under a deep blue sky",
    place: "Spiti Valley, Himachal Pradesh, India",
    photographer: "buddy sagar",
    photographerUrl: "https://www.pexels.com/@exploredestination2/",
    sourceUrl: "https://www.pexels.com/photo/spiti-valley-27662410/",
    licence: "Pexels License",
  },
  {
    id: "meghalaya-hills",
    src: "/welcome/meghalaya-hills.webp",
    alt: "Green grassy plateau edge overlooking forested cliffs and valleys",
    place: "Meghalaya, India",
    photographer: "Subhadeep Kundu",
    photographerUrl: "https://www.pexels.com/@sratk07/",
    sourceUrl: "https://www.pexels.com/photo/meghalaya-10101268/",
    licence: "Pexels License",
  },
  {
    id: "kerala-houseboat",
    src: "/welcome/kerala-houseboat.webp",
    alt: "Traditional thatched houseboat on calm backwaters beside a lone coconut palm",
    place: "Kerala backwaters, India",
    photographer: "Godson Bright",
    photographerUrl: "https://www.pexels.com/@godson-bright-352845",
    sourceUrl: "https://www.pexels.com/photo/962464/",
    licence: "Pexels License",
  },
  {
    id: "goa-coast",
    src: "/welcome/goa-coast.webp",
    alt: "Aerial view of a long sandy beach and turquoise surf along a coastal village",
    place: "Goa, India",
    photographer: "Kiran Patel",
    photographerUrl: "https://www.pexels.com/@kiran-patel-83913791/",
    sourceUrl: "https://www.pexels.com/photo/23630487/",
    licence: "Pexels License",
  },
  {
    id: "maldives-palm-shore",
    src: "/welcome/maldives-palm-shore.webp",
    alt: "Palm-lined rocky shore beside clear turquoise water",
    place: "Maldives",
    photographer: "Asad Photo Maldives",
    photographerUrl: "https://www.pexels.com/@asadphoto/",
    sourceUrl: "https://www.pexels.com/photo/green-palm-trees-on-beach-side-1266835/",
    licence: "Pexels License",
  },
  {
    id: "maldives-lagoon",
    src: "/welcome/maldives-lagoon.webp",
    alt: "Aerial view of a shallow turquoise lagoon with a small palm island",
    place: "Maldives",
    photographer: "Asad Photo Maldives",
    photographerUrl: "https://www.pexels.com/@asadphoto/",
    sourceUrl: "https://www.pexels.com/photo/28859944/",
    licence: "Pexels License",
  },
  {
    id: "merzouga-dunes",
    src: "/welcome/merzouga-dunes.webp",
    alt: "Rolling sand dunes under a pale evening sky",
    place: "Merzouga, Sahara Desert, Morocco",
    photographer: "Ed Duvico",
    photographerUrl: "https://www.pexels.com/@ed-duvico-530456/",
    sourceUrl: "https://www.pexels.com/photo/29107887/",
    licence: "Pexels License",
  },
];

/** Pure Fisher-Yates shuffle; andom must return values in [0, 1). */
export function shuffleIds(ids: readonly string[], random: () => number): string[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** Order for the next cycle; the first item never equals lastId (when more than one id). */
export function nextCycle(
  ids: readonly string[],
  random: () => number,
  lastId?: string,
): string[] {
  const out = shuffleIds(ids, random);
  if (out.length > 1 && lastId !== undefined && out[0] === lastId) {
    const last = out.length - 1;
    const tmp = out[0];
    out[0] = out[last];
    out[last] = tmp;
  }
  return out;
}
