package com.donoy.mybandpractice.v2.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.snapshots.Snapshot

/**
 * Keeps [calculation] up to date, outside composition: it runs again whenever a state it
 * reads changes, and the returned state only changes when the result does. When the
 * lambda is a new one (it captures something else now), the follow-up starts over.
 *
 * A `derivedStateOf` that is read while composing gets the same result, but Compose starts
 * a recomposition pass for every change of a state the calculation reads. For the playhead
 * that is ten passes a second, each walking the tree to find that nothing changed.
 */
@Composable
fun <T> followAsState(calculation: () -> T): State<T> {
    val value = remember(calculation) { mutableStateOf(Snapshot.withoutReadObservation { calculation() }) }
    LaunchedEffect(calculation) {
        snapshotFlow { calculation() }.collect { value.value = it }
    }
    return value
}
