// Shell side only: maps an effect type to its class. Parameter names, descriptions and defaults for the
// preferences are in ../defs.js. Effects from "Blur my Shell" by aunetx (GPL-3.0).
import { NativeDynamicBlurEffect } from './native_dynamic_gaussian_blur.js';
import { NativeStaticBlurEffect } from './native_static_gaussian_blur.js';
import { GaussianBlurEffect } from './gaussian_blur.js';
import { MonteCarloBlurEffect } from './monte_carlo_blur.js';
import { ColorEffect } from './color.js';
import { NoiseEffect } from './noise.js';
import { CornerEffect } from './corner.js';
import { DownscaleEffect } from './downscale.js';
import { UpscaleEffect } from './upscale.js';
import { PixelizeEffect } from './pixelize.js';
import { DerivativeEffect } from './derivative.js';
import { RgbToHslEffect } from './rgb_to_hsl.js';
import { HslToRgbEffect } from './hsl_to_rgb.js';
import { LuminosityEffect } from './luminosity.js';

export function get_supported_effects() {
    return {
        native_dynamic_gaussian_blur: {class: NativeDynamicBlurEffect},
        native_static_gaussian_blur: {class: NativeStaticBlurEffect},
        gaussian_blur: {class: GaussianBlurEffect},
        monte_carlo_blur: {class: MonteCarloBlurEffect},
        color: {class: ColorEffect},
        luminosity: {class: LuminosityEffect},
        pixelize: {class: PixelizeEffect},
        downscale: {class: DownscaleEffect},
        upscale: {class: UpscaleEffect},
        derivative: {class: DerivativeEffect},
        noise: {class: NoiseEffect},
        rgb_to_hsl: {class: RgbToHslEffect},
        hsl_to_rgb: {class: HslToRgbEffect},
        corner: {class: CornerEffect},
    };
}
