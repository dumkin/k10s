//! How the window looks before the web view says anything: its own colour (what shows before the page paints its
//! first frame, and around it while it resizes) and the page's zoom. Both follow the UI and are kept with its settings
//! (see `prefs`), so the next start opens with them: a light UI does not flash dark at launch (nor a dark one light),
//! and a zoomed one does not jump from 100% once it has loaded.

use tauri::window::Color;

/// The UI's darkest surface in each theme (`--bg` in `src/styles/tokens.css`).
pub const DARK: Color = Color(0x0b, 0x0c, 0x0e, 0xff);
pub const LIGHT: Color = Color(0xe9, 0xeb, 0xee, 0xff);

/// How far the page may be zoomed out and in (the UI steps between these).
pub const ZOOM_MIN: f64 = 0.5;
pub const ZOOM_MAX: f64 = 2.0;

/// The colour of a theme by its name, as the UI calls them.
pub fn color(theme: &str) -> Option<Color> {
    match theme {
        "dark" => Some(DARK),
        "light" => Some(LIGHT),
        _ => None,
    }
}

pub fn clamp_zoom(zoom: f64) -> f64 {
    zoom.clamp(ZOOM_MIN, ZOOM_MAX)
}

/// The zoom to open the page at: none at 100%, and one out of range brought into it.
pub fn zoom_to_apply(zoom: f64) -> Option<f64> {
    (zoom.is_finite() && (zoom - 1.0).abs() > 1e-3).then(|| clamp_zoom(zoom))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn themes_have_colours_and_zooms_stay_in_range() {
        assert_eq!((color("dark"), color("light"), color("sepia")), (Some(DARK), Some(LIGHT), None));
        assert_eq!(zoom_to_apply(1.25), Some(1.25));
        assert_eq!(zoom_to_apply(1.0), None);
        assert_eq!(zoom_to_apply(9.0), Some(ZOOM_MAX));
        assert_eq!(zoom_to_apply(f64::NAN), None);
    }
}
