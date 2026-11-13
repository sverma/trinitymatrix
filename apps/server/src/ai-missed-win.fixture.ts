import type { Card } from "@trinitymatrix/protocol";

// Sanitized regression: an immediately winning deal that a v1 model kept discarding.
export const missedWinWildRank = 11;
export const missedWinHand13: Card[] = [
  {
    "id": "winning-card-1",
    "deck": 1,
    "rank": 5,
    "suit": "clubs",
    "printedJoker": false
  },
  {
    "id": "winning-card-2",
    "deck": 1,
    "rank": null,
    "suit": null,
    "printedJoker": true
  },
  {
    "id": "winning-card-3",
    "deck": 1,
    "rank": 10,
    "suit": "diamonds",
    "printedJoker": false
  },
  {
    "id": "winning-card-4",
    "deck": 1,
    "rank": 11,
    "suit": "diamonds",
    "printedJoker": false
  },
  {
    "id": "winning-card-5",
    "deck": 1,
    "rank": 1,
    "suit": "hearts",
    "printedJoker": false
  },
  {
    "id": "winning-card-6",
    "deck": 1,
    "rank": 13,
    "suit": "diamonds",
    "printedJoker": false
  },
  {
    "id": "winning-card-7",
    "deck": 1,
    "rank": 2,
    "suit": "clubs",
    "printedJoker": false
  },
  {
    "id": "winning-card-8",
    "deck": 1,
    "rank": 13,
    "suit": "clubs",
    "printedJoker": false
  },
  {
    "id": "winning-card-9",
    "deck": 1,
    "rank": 10,
    "suit": "clubs",
    "printedJoker": false
  },
  {
    "id": "winning-card-10",
    "deck": 1,
    "rank": 6,
    "suit": "spades",
    "printedJoker": false
  },
  {
    "id": "winning-card-11",
    "deck": 1,
    "rank": 3,
    "suit": "diamonds",
    "printedJoker": false
  },
  {
    "id": "winning-card-12",
    "deck": 1,
    "rank": 10,
    "suit": "hearts",
    "printedJoker": false
  },
  {
    "id": "winning-card-13",
    "deck": 1,
    "rank": 1,
    "suit": "spades",
    "printedJoker": false
  }
];
export const missedWinHand14: Card[] = [
  {
    "id": "winning-card-1",
    "deck": 1,
    "rank": 5,
    "suit": "clubs",
    "printedJoker": false
  },
  {
    "id": "winning-card-2",
    "deck": 1,
    "rank": null,
    "suit": null,
    "printedJoker": true
  },
  {
    "id": "winning-card-3",
    "deck": 1,
    "rank": 10,
    "suit": "diamonds",
    "printedJoker": false
  },
  {
    "id": "winning-card-4",
    "deck": 1,
    "rank": 11,
    "suit": "diamonds",
    "printedJoker": false
  },
  {
    "id": "winning-card-5",
    "deck": 1,
    "rank": 1,
    "suit": "hearts",
    "printedJoker": false
  },
  {
    "id": "winning-card-6",
    "deck": 1,
    "rank": 13,
    "suit": "diamonds",
    "printedJoker": false
  },
  {
    "id": "winning-card-7",
    "deck": 1,
    "rank": 2,
    "suit": "clubs",
    "printedJoker": false
  },
  {
    "id": "winning-card-8",
    "deck": 1,
    "rank": 13,
    "suit": "clubs",
    "printedJoker": false
  },
  {
    "id": "winning-card-9",
    "deck": 1,
    "rank": 10,
    "suit": "clubs",
    "printedJoker": false
  },
  {
    "id": "winning-card-10",
    "deck": 1,
    "rank": 6,
    "suit": "spades",
    "printedJoker": false
  },
  {
    "id": "winning-card-11",
    "deck": 1,
    "rank": 3,
    "suit": "diamonds",
    "printedJoker": false
  },
  {
    "id": "winning-card-12",
    "deck": 1,
    "rank": 10,
    "suit": "hearts",
    "printedJoker": false
  },
  {
    "id": "winning-card-13",
    "deck": 1,
    "rank": 1,
    "suit": "spades",
    "printedJoker": false
  },
  {
    "id": "winning-card-14",
    "deck": 1,
    "rank": 6,
    "suit": "clubs",
    "printedJoker": false
  }
];
export const missedWinDeclaration = {
  "cardId": "winning-card-14",
  "groups": [
    [
      "winning-card-7",
      "winning-card-11",
      "winning-card-12",
      "winning-card-10"
    ],
    [
      "winning-card-1",
      "winning-card-5",
      "winning-card-13"
    ],
    [
      "winning-card-9",
      "winning-card-8",
      "winning-card-4"
    ],
    [
      "winning-card-3",
      "winning-card-6",
      "winning-card-2"
    ]
  ],
  "score": 102
};
