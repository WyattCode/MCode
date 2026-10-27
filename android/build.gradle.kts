plugins {
    id("com.android.application") version "8.4.2" apply false
    // Kotlin 2.0 and its own Compose plugin.
    //
    // Compose 1.7 (the first release that exposes `SelectionRegistrar` without
    // an opt-in) requires the Compose compiler to ship as a Kotlin plugin: the
    // `composeOptions.kotlinCompilerExtensionVersion` knob stopped at 1.5.x for
    // Kotlin 1.9, and a 1.7 runtime under that compiler is refused outright.
    // AGP stays at 8.4.2 - 8.4 already understands Kotlin 2.0 and the JDK 21
    // this machine builds with.
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
}