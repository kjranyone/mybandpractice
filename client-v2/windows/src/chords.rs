use std::fs;
use std::path::Path;

use serde::Deserialize;

#[derive(Deserialize)]
pub struct ChordChart {
    pub key: Option<String>,
    pub bpm: Option<f64>,
    pub time_signature: Option<String>,
    #[serde(default)]
    pub bars: Vec<Bar>,
    #[serde(default)]
    chords: Vec<Chord>,
}

#[derive(Deserialize)]
pub struct Bar {
    pub bar_number: Option<usize>,
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub chords: Vec<Chord>,
}

#[derive(Clone, Deserialize)]
pub struct Chord {
    pub chord: String,
    pub start: f64,
    pub end: f64,
}

impl ChordChart {
    pub fn load(directory: &Path) -> Option<Self> {
        let data = fs::read(directory.join("chords.json")).ok()?;
        Self::parse(&data)
    }

    fn parse(data: &[u8]) -> Option<Self> {
        let mut chart: Self = serde_json::from_slice(data).ok()?;
        chart
            .bars
            .retain(|bar| bar.start >= 0.0 && bar.end > bar.start);
        chart.bars.sort_by(|a, b| a.start.total_cmp(&b.start));
        for bar in &mut chart.bars {
            bar.chords.retain(Chord::valid);
        }
        if chart.bars.is_empty() {
            chart.chords.retain(Chord::valid);
            chart.chords.sort_by(|a, b| a.start.total_cmp(&b.start));
            let last_end = chart
                .chords
                .iter()
                .map(|chord| chord.end)
                .reduce(f64::max)?;
            let bpm = chart
                .bpm
                .filter(|bpm| (20.0..=400.0).contains(bpm))
                .unwrap_or(120.0);
            let bar_length = 240.0 / bpm;
            for index in 0..((last_end / bar_length).ceil() as usize).min(10_000) {
                let start = index as f64 * bar_length;
                let end = (start + bar_length).min(last_end);
                let first = chart
                    .chords
                    .iter()
                    .position(|chord| chord.end > start)
                    .unwrap_or(chart.chords.len());
                let chords = chart.chords[first..]
                    .iter()
                    .take_while(|chord| chord.start < end)
                    .filter(|chord| chord.end > start)
                    .map(|chord| Chord {
                        start: chord.start.max(start),
                        end: chord.end.min(end),
                        chord: chord.chord.clone(),
                    })
                    .collect();
                chart.bars.push(Bar {
                    bar_number: Some(index + 1),
                    start,
                    end,
                    chords,
                });
            }
        }
        (!chart.bars.is_empty()).then_some(chart)
    }
}

impl Chord {
    fn valid(&self) -> bool {
        !self.chord.trim().is_empty() && self.start >= 0.0 && self.end > self.start
    }
}

pub fn transpose(symbol: &str, semitones: i32) -> String {
    const NOTES: [&str; 12] = [
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    ];
    fn transpose_root(part: &str, semitones: i32) -> String {
        let mut characters = part.char_indices();
        let Some((_, root)) = characters.next() else {
            return String::new();
        };
        let note = match root {
            'C' => 0,
            'D' => 2,
            'E' => 4,
            'F' => 5,
            'G' => 7,
            'A' => 9,
            'B' => 11,
            _ => return part.to_owned(),
        };
        let (accidental, prefix) = match characters.next() {
            Some((index, modifier @ ('#' | '♯'))) => (1, index + modifier.len_utf8()),
            Some((index, modifier @ ('b' | '♭'))) => (-1, index + modifier.len_utf8()),
            _ => (0, root.len_utf8()),
        };
        format!(
            "{}{}",
            NOTES[(note + accidental + semitones).rem_euclid(12) as usize],
            &part[prefix..]
        )
    }

    if semitones == 0 {
        symbol.to_owned()
    } else {
        symbol
            .split('/')
            .map(|part| transpose_root(part, semitones))
            .collect::<Vec<_>>()
            .join("/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_explicit_bars_and_supports_legacy_timed_chords() {
        let explicit = ChordChart::parse(br#"{"key":"F#","bpm":150,"bars":[{"bar_number":3,"start":2.0,"end":4.0,"chords":[{"chord":"D#m","start":2.0,"end":4.0}]}]}"#).unwrap();
        assert_eq!(explicit.bars[0].bar_number, Some(3));
        let legacy =
            ChordChart::parse(br#"{"bpm":120,"chords":[{"chord":"Am","start":1.0,"end":3.0}]}"#)
                .unwrap();
        assert_eq!(legacy.bars[0].chords[0].end, 2.0);
        assert_eq!(legacy.bars[1].chords[0].start, 2.0);
        assert_eq!(transpose("Bbmaj7/F", 2), "Cmaj7/G");
        assert_eq!(transpose("N.C.", -2), "N.C.");
    }
}
