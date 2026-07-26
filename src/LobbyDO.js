// Matchmaker. Fills one public room to 4, then rotates to a fresh one.
// ponytail: no leave-tracking, so seats aren't backfilled after someone leaves a
// public room — RoomDO enforces the real cap of 4 and rejects overflow with 403,
// and the client just re-matches. Add per-room counts if backfill ever matters.

export class LobbyDO {
  constructor() {
    this.roomId = null;
    this.count = 0;
  }

  async fetch() {
    if (!this.roomId || this.count >= 4) {
      this.roomId = crypto.randomUUID();
      this.count = 0;
    }
    this.count++;
    return Response.json({ roomId: this.roomId });
  }
}
