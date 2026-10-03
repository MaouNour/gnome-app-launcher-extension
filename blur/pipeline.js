// Builds the effects of a pipeline on one actor. Same rules as Blur my Shell's `Pipeline` (aunetx, GPL-3.0):
// effects come from an `EffectsManager` (recycled instead of destroyed), and they are added in reverse order so
// that the first effect of the list is the first one applied to the image.
import {warn} from '../utils/log.js';

export class BlurPipeline {
    constructor(effectsManager) {
        this._em = effectsManager;
        this.effects = [];
        this.actor = null;
    }

    // descriptors: [{type, id, params}] as stored. overrides.cornerRadius, when given, replaces the radius of
    // every "corner" effect (the launcher theme's radius).
    apply(actor, descriptors, overrides = {}) {
        this.clear();
        this.actor = actor;
        for (const d of descriptors) {
            const make = this._em[`new_${d.type}_effect`];
            if (typeof make !== 'function') {
                warn(`blur: effect "${d.type}" not found`);
                continue;
            }
            const params = {...d.params};
            if (d.type === 'corner' && overrides.cornerRadius !== null && overrides.cornerRadius !== undefined)
                params.radius = overrides.cornerRadius;
            try {
                this.effects.push(make.call(this._em, params));
            } catch (e) {
                warn(`blur: could not build effect "${d.type}": ${e.message}`);
            }
        }
        this.effects.reverse();
        for (const e of this.effects) {
            try {
                actor.add_effect(e);
            } catch (err) {
                warn(`blur: could not add an effect: ${err.message}`);
            }
        }
    }

    // Takes every effect off the actor. They are not destroyed: the manager keeps them for reuse.
    clear() {
        for (const e of this.effects)
            this._em.remove(e);
        this.effects = [];
        this.actor = null;
    }
}
