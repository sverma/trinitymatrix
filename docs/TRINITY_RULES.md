# Trinity rules

This document is the rule contract implemented by both the browser and the authoritative server.

## Cards and values

- Suits are clubs, diamonds, hearts, and spades.
- Cards 2 through 10 use their printed value.
- Jack, Queen, and King are each worth 10.
- Ace may be worth 1 or 11, whichever produces a valid meld total.
- Each round selects one wild rank. Every card of that rank is wild.
- Printed jokers are also wild.

## Valid meld

A group is a valid meld when all of these conditions hold:

1. It contains at least three cards.
2. Its natural cards are all from the same suit, or every natural card has a different suit.
3. Its total is one of 3, 6, 9, 12, 15, 18, 21, 24, or 27.
4. If its total is 21, every card in the meld is natural: it contains no printed joker and no card matching the selected wild rank.

Any total above 27 is invalid even when it is divisible by three.

Wild cards are exempt from the suit condition and may represent values from 1 through 11 in non-21 melds. A 21-point assignment is never available to a meld containing a wild. If several assignments remain possible, the highest valid total is used. A natural meld capable of 21 is resolved as 21 so the required Trinity meld is deterministic.

Examples:

- Ace of clubs + 10 of spades + Queen of hearts = 21. The natural suits are all different and the Ace is worth 1.
- King of hearts + Queen of clubs + 4 of spades = 24. The natural suits are all different.
- King + Queen + Jack of one suit = 30 and is invalid because 27 is the maximum.
- 3, 6, and 9 of one suit = 18 and is valid.
- 8 and 10 of clubs plus a printed joker cannot be a 21-point Trinity meld; the joker may instead resolve that meld to another permitted total such as 24 or 27.
- 3 of clubs + 6 of diamonds + 9 of clubs is invalid because a mixed-suit meld repeats clubs.

## Turn and declaration

1. Each player starts with 13 cards.
2. On a turn, the player draws from the closed deck or takes the top open-deck card.
3. The player discards one card to finish the turn, or stages one card as the final discard and declares.
4. After the final discard, the remaining 13 cards must appear exactly once across valid melds.
5. At least one submitted meld must contain only natural cards and total exactly 21.
6. The declaration score is the sum of the resolved meld totals.

An invalid declaration is committed: the declaring player drops from active play, and the remaining players continue unless only one remains.

## Product assumptions

The original handwritten rules specify meld construction and scoring but do not define the surrounding turn structure. TrinityMatrix therefore adopts these explicit product rules from its RummyMatrix reference:

- 13-card hands
- draw-one, discard-one turns
- a selected wild rank plus printed jokers
- 2-player and 6-player tables
- a valid declaration wins the round
- other active players submit their final layouts for the replay after a declaration

These assumptions are kept separate from the meld validator so they can be changed as the original game design is refined.
