// Pure JS (no GI imports), shared by the Shell side and the preferences. The effects and shaders in
// blur/effects/ come from "Blur my Shell" by aunetx (GPL-3.0, see LICENSE-blur-my-shell); this file holds the
// parts the preferences need to build an editor: names, descriptions, editable parameters and defaults.

export const EFFECTS = {

    native_static_gaussian_blur: {
        name: "Native gaussian blur",
        description: "An optimized blur effect that smoothly blends pixels within a given radius.",
        is_advanced: false,
        defaults: {"unscaled_radius": 30, "brightness": 0.6},
        editable_params: {
            unscaled_radius: {
                name: "Radius",
                description: "The intensity of the blur effect.",
                type: "float",
                min: 0.,
                max: 100.,
                increment: 1.0,
                big_increment: 10.,
                digits: 0
            },
            brightness: {
                name: "Brightness",
                description: "The brightness of the blur effect, a high value might make the text harder to read.",
                type: "float",
                min: 0.,
                max: 1.,
                increment: 0.01,
                big_increment: 0.1,
                digits: 2
            },
        }
    },

    gaussian_blur: {
        name: "Gaussian blur (advanced effect)",
        description: "A blur effect that smoothly blends pixels within a given radius. This effect is more precise, but way less optimized.",
        is_advanced: true,
        defaults: {"radius": 30, "brightness": 0.6},
        editable_params: {
            radius: {
                name: "Radius",
                description: "The intensity of the blur effect. The bigger it is, the slower it will be.",
                type: "float",
                min: 0.,
                max: 100.,
                increment: .1,
                big_increment: 10.,
                digits: 1
            },
            brightness: {
                name: "Brightness",
                description: "The brightness of the blur effect, a high value might make the text harder to read.",
                type: "float",
                min: 0.,
                max: 1.,
                increment: 0.01,
                big_increment: 0.1,
                digits: 2
            },
        }
    },

    monte_carlo_blur: {
        name: "Monte Carlo blur",
        description: "A blur effect that mimics a random walk, by picking pixels further and further away from its origin and mixing them all together.",
        is_advanced: false,
        defaults: {"radius": 2, "iterations": 5, "brightness": 0.6, "use_base_pixel": true, "prefer_closer_pixels": true},
        editable_params: {
            radius: {
                name: "Radius",
                description: "The maximum travel distance for each step in the random walk. A higher value will make the blur more randomized.",
                type: "float",
                min: 0.,
                max: 10.,
                increment: 0.01,
                big_increment: 0.1,
                digits: 2
            },
            iterations: {
                name: "Iterations",
                description: "The number of iterations. The more there are, the smoother the blur is.",
                type: "integer",
                min: 0,
                max: 50,
                increment: 1
            },
            brightness: {
                name: "Brightness",
                description: "The brightness of the blur effect, a high value might make the text harder to read.",
                type: "float",
                min: 0.,
                max: 1.,
                increment: 0.01,
                big_increment: 0.1,
                digits: 2
            },
            use_base_pixel: {
                name: "Use base pixel",
                description: "Whether or not the original pixel is counted for the blur. If it is, the image will be more legible.",
                type: "boolean"
            },
            prefer_closer_pixels: {
                name: "Prefer closer pixels",
                description: "Whether or not the pixels that are closer to the original pixel will have more weight.",
                type: "boolean"
            }
        }
    },

    color: {
        name: "Color",
        description: "An effect that blends a color into the pipeline.",
        is_advanced: false,
        defaults: {"color": [0, 0, 0, 0], "blend_mode": 0},
        // TODO make this RGB + blend
        editable_params: {
            color: {
                name: "Color",
                description: "The color to blend in. The blending amount is controled by the opacity of the color.",
                type: "rgba",
                use_alpha: true
            },
            blend_mode: {
                name: "Blend mode",
                description: "How the color is blended in.",
                type: "dropdown",
                options: [
                    "Normal",
                    "Multiply",
                    "Screen",
                    "Overlay",
                    "Darken",
                    "Lighten",
                    "Plus darker",
                    "Plus lighter",
                    "Color dodge",
                    "Color burn",
                    "Hard light",
                    "Soft light",
                    "Difference",
                    "Exclusion",
                    "Hue",
                    "Saturation",
                    "Color",
                    "Luminosity"
                ]
            }
        }
    },

    luminosity: {
        name: "Luminosity",
        description: "An effect that affects the luminosity of the image.",
        is_advanced: false,
        defaults: {"brightness_shift": 0, "brightness_multiplicator": 1, "contrast": 1, "contrast_center": 0.5, "saturation_multiplicator": 1},
        editable_params: {
            brightness_shift: {
                name: "Shift brightness",
                description: "The brightness to add of remove to the image.",
                type: "float",
                min: -1.,
                max: 1.,
                increment: 0.01,
                big_increment: 0.1,
                digits: 2
            },
            brightness_multiplicator: {
                name: "Multiply brightness",
                description: "The brightness multiplicator of the image, so that 0 means no brightness and 2 means infinite brightness.",
                type: "float",
                min: 0.,
                max: 2.,
                increment: 0.01,
                big_increment: 0.1,
                digits: 2
            },
            contrast: {
                name: "Contrast",
                description: "The contrast of the image in regard to the center of the contrast.",
                type: "float",
                min: 0.,
                max: 2.,
                increment: 0.01,
                big_increment: 0.1,
                digits: 2
            },
            contrast_center: {
                name: "Contrast center",
                description: "The center of the contrast to use.",
                type: "float",
                min: 0.,
                max: 1.,
                increment: 0.01,
                big_increment: 0.1,
                digits: 2
            },
            saturation_multiplicator: {
                name: "Saturation",
                description: "The saturation of the image, so that 0 means no saturation and 2 means infinite saturation.",
                type: "float",
                min: 0.,
                max: 2.,
                increment: 0.01,
                big_increment: 0.1,
                digits: 2
            },
        }
    },

    pixelize: {
        name: "Pixelize",
        description: "An effect that pixelizes the image.",
        is_advanced: false,
        defaults: {"factor": 8, "downsampling_mode": 0},
        editable_params: {
            factor: {
                name: "Factor",
                description: "How much to scale down the image.",
                type: "integer",
                min: 1,
                max: 50,
                increment: 1
            },
            downsampling_mode: {
                name: "Downsampling mode",
                description: "The downsampling method that is used.",
                type: "dropdown",
                options: [
                    "Boxcar",
                    "Triangular",
                    "Dirac"
                ]
            }
        }
    },

    downscale: {
        name: "Downscale (advanced effect)",
        description: "An effect that downscales the image and put it on the top-left corner.",
        is_advanced: true,
        defaults: {"divider": 8, "downsampling_mode": 0},
        editable_params: {
            divider: {
                name: "Factor",
                description: "How much to scale down the image.",
                type: "integer",
                min: 1,
                max: 50,
                increment: 1
            },
            downsampling_mode: {
                name: "Downsampling mode",
                description: "The downsampling method that is used.",
                type: "dropdown",
                options: [
                    "Boxcar",
                    "Triangular",
                    "Dirac"
                ]
            }
        }
    },

    upscale: {
        name: "Upscale (advanced effect)",
        description: "An effect that upscales the image from the top-left corner.",
        is_advanced: true,
        defaults: {"factor": 8},
        editable_params: {
            factor: {
                name: "Factor",
                description: "How much to scale up the image.",
                type: "integer",
                min: 1,
                max: 50,
                increment: 1
            }
        }
    },

    derivative: {
        name: "Derivative",
        description: "Apply a spatial derivative, or a laplacian.",
        is_advanced: false,
        defaults: {"operation": 0},
        editable_params: {
            operation: {
                name: "Operation",
                description: "The mathematical operation to apply.",
                type: "dropdown",
                options: [
                    "1-step derivative",
                    "2-step derivative",
                    "Laplacian"
                ]
            }
        }
    },

    noise: {
        name: "Noise",
        description: "An effect that adds a random noise. Prefer the Monte Carlo blur for a more organic effect if needed.",
        is_advanced: false,
        defaults: {"noise": 0.4, "lightness": 0.4},
        editable_params: {
            noise: {
                name: "Noise",
                description: "The amount of noise to add.",
                type: "float",
                min: 0.,
                max: 1.,
                increment: 0.01,
                big_increment: 0.1,
                digits: 2
            },
            lightness: {
                name: "Lightness",
                description: "The luminosity of the noise. A setting of '1.0' will make the effect transparent.",
                type: "float",
                min: 0.,
                max: 2.,
                increment: 0.01,
                big_increment: 0.1,
                digits: 2
            }
        }
    },

    rgb_to_hsl: {
        name: "RGB to HSL (advanced effect)",
        description: "Converts the image from RGBA colorspace to HSLA.",
        is_advanced: true,
        defaults: {},
        editable_params: {}
    },

    hsl_to_rgb: {
        name: "HSL to RGB (advanced effect)",
        description: "Converts the image from HSLA colorspace to RGBA.",
        is_advanced: true,
        defaults: {},
        editable_params: {}
    },

    corner: {
        name: "Corner",
        description: "An effect that draws corners. Add it last not to have the other effects perturb the corners.",
        is_advanced: false,
        defaults: {"radius": 12, "corners_top": true, "corners_bottom": true},
        editable_params: {
            radius: {
                name: "Radius",
                description: "The radius of the corner. GNOME apps use a radius of 12 px by default.",
                type: "integer",
                min: 0,
                max: 150,
                increment: 1,
            },
            corners_top: {
                name: "Top corners",
                description: "Whether or not to round the top corners.",
                type: "boolean"
            },
            corners_bottom: {
                name: "Bottom corners",
                description: "Whether or not to round the bottom corners.",
                type: "boolean"
            }
        }
    }
};

export const GROUPS = {
    blur_effects: {name: 'Blur effects', contains: ['native_static_gaussian_blur', 'gaussian_blur', 'monte_carlo_blur']},
    texture_effects: {
        name: 'Texture effects',
        contains: ['downscale', 'upscale', 'pixelize', 'derivative', 'noise', 'color', 'luminosity', 'rgb_to_hsl', 'hsl_to_rgb'],
    },
    shape_effects: {name: 'Shape effects', contains: ['corner']},
};

// Pipelines that exist from the start. Ids are fixed so that a selected pipeline survives a reset.
export const DEFAULT_PIPELINES = {
    pipeline_default: {
        name: 'Default',
        effects: [{type: 'native_static_gaussian_blur', id: 'effect_000000000000', params: {unscaled_radius: 30, brightness: 0.6}}],
    },
    pipeline_default_rounded: {
        name: 'Default rounded',
        effects: [
            {type: 'native_static_gaussian_blur', id: 'effect_000000000001', params: {unscaled_radius: 30, brightness: 0.6}},
            {type: 'corner', id: 'effect_000000000002', params: {radius: 24}},
        ],
    },
};

const rid = () => `${Math.random()}`.slice(2, 16);
export const newPipelineId = () => `pipeline_${rid()}`;
export const newEffectId = () => `effect_${rid()}`;

export const isEffectType = t => typeof t === 'string' && Object.prototype.hasOwnProperty.call(EFFECTS, t);

// A new effect of `type` with its default parameters (only the editable ones are stored).
export function newEffect(type) {
    const def = EFFECTS[type];
    const params = {};
    for (const k of Object.keys(def.editable_params))
        params[k] = Array.isArray(def.defaults[k]) ? [...def.defaults[k]] : def.defaults[k];
    return {type, id: newEffectId(), params};
}

function cleanValue(spec, v, fallback) {
    switch (spec.type) {
    case 'float':
    case 'integer': {
        if (typeof v !== 'number' || !Number.isFinite(v))
            return fallback;
        const n = Math.min(spec.max, Math.max(spec.min, v));
        return spec.type === 'integer' ? Math.round(n) : n;
    }
    case 'boolean':
        return typeof v === 'boolean' ? v : fallback;
    case 'dropdown':
        return Number.isInteger(v) && v >= 0 && v < spec.options.length ? v : fallback;
    case 'rgba':
        return Array.isArray(v) && v.length === 4 && v.every(x => typeof x === 'number' && Number.isFinite(x))
            ? v.map(x => Math.min(1, Math.max(0, x))) : fallback;
    default:
        return fallback;
    }
}

// Parameters of an effect as stored (or as typed by hand): unknown keys dropped, values clamped,
// anything missing falls back to the default.
export function cleanParams(type, params) {
    const def = EFFECTS[type];
    const out = {};
    const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
    for (const [k, spec] of Object.entries(def.editable_params)) {
        const d = def.defaults[k];
        out[k] = cleanValue(spec, p[k], Array.isArray(d) ? [...d] : d);
    }
    return out;
}

// {id: {name, effects: [{type, id, params}]}} from stored JSON. Malformed pipelines and effects are dropped;
// the default pipelines are always present.
export function sanitizePipelines(raw) {
    const out = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [id, p] of Object.entries(raw)) {
            if (!/^[A-Za-z0-9_]{1,40}$/.test(id) || !p || typeof p !== 'object' || !Array.isArray(p.effects))
                continue;
            const effects = [];
            const seen = new Set();
            for (const e of p.effects.slice(0, 24)) {
                if (!e || !isEffectType(e.type))
                    continue;
                let eid = typeof e.id === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(e.id) ? e.id : newEffectId();
                if (seen.has(eid))
                    eid = newEffectId();
                seen.add(eid);
                effects.push({type: e.type, id: eid, params: cleanParams(e.type, e.params)});
            }
            const name = typeof p.name === 'string' ? p.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : '';
            out[id] = {name: name || id, effects};
        }
    }
    for (const [id, p] of Object.entries(DEFAULT_PIPELINES)) {
        if (!out[id]) {
            // Same cleaning as stored pipelines, so a default and a stored copy of it compare equal.
            out[id] = {
                name: p.name,
                effects: p.effects.map(e => ({type: e.type, id: e.id, params: cleanParams(e.type, e.params)})),
            };
        }
    }
    return out;
}

// The id to use: the selected one if it exists, else the default.
export function pickPipeline(pipelines, id) {
    return pipelines[id] ? id : 'pipeline_default';
}

// Which settings give which blur. mode: theme | dynamic | static | off.
//  theme   : the launcher theme's own "blur strength" (dynamic blur), nothing else to configure
//  dynamic : native blur of whatever is behind the launcher, with the strength set on the Blur page
//  static  : the wallpaper, blurred through a pipeline of effects
// Returns {kind: 'none'|'dynamic'|'static', sigma, brightness, cornerRadius, pipeline}.
export function resolveBlur(o) {
    const mode = ['theme', 'dynamic', 'static', 'off'].includes(o.mode) ? o.mode : 'theme';
    const corner = o.cornerAuto ? o.themeRadius : o.cornerRadius;
    if (mode === 'off')
        return {kind: 'none'};
    if (mode === 'theme')
        return o.themeSigma > 0 ? {kind: 'dynamic', sigma: o.themeSigma, brightness: 1, cornerRadius: o.themeRadius} : {kind: 'none'};
    if (mode === 'dynamic')
        return o.sigma > 0 ? {kind: 'dynamic', sigma: o.sigma, brightness: o.brightness, cornerRadius: corner} : {kind: 'none'};
    const pipelines = sanitizePipelines(o.pipelines);
    const id = pickPipeline(pipelines, o.pipeline);
    return {kind: 'static', pipeline: pipelines[id].effects, pipelineId: id, cornerRadius: corner, followCorner: !!o.cornerAuto};
}
