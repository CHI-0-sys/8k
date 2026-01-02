class Mutex {
    constructor() {
        this._queue = [];
        this._locked = false;
    }

    acquire() {
        return new Promise((resolve) => {
            const release = () => {
                const next = this._queue.shift();
                if (next) {
                    next();
                } else {
                    this._locked = false;
                }
            };

            if (this._locked) {
                this._queue.push(() => resolve(release));
            } else {
                this._locked = true;
                resolve(release);
            }
        });
    }

    async runExclusive(callback) {
        const release = await this.acquire();
        try {
            return await callback();
        } finally {
            release();
        }
    }
}

module.exports = Mutex;
