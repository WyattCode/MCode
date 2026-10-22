plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.mcode.remote"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.mcode.remote"
        minSdk = 29
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    /*
     * No `composeOptions` block.
     *
     * The compiler extension version is chosen by `org.jetbrains.kotlin.plugin.compose`
     * since Kotlin 2.0 - leaving 1.5.14 here would either be ignored or
     * conflict, and either way it no longer describes the compiler in use.
     */
    packaging {
        resources.excludes += "META-INF/*"
    }
}

dependencies {
    /*
     * 2024.09.03 is the first BOM on foundation 1.7.8 - the release where
     * `SelectionRegistrar` carries no opt-in annotation (verified against the
     * published artifact: its class file has no `@InternalFoundationApi` and no
     * `@ExperimentalFoundationApi`), and `Selection` exposes `start`/`end`
     * offsets through `getSubselections`.
     */
    val composeBom = platform("androidx.compose:compose-bom:2024.09.03")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material3:material3-window-size-class")
    implementation("androidx.window:window:1.3.0")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    /*
     * JVM tests, for the selection's arithmetic.
     *
     * Two bugs in `Markdown.kt` were pure offset mathematics - a slice handed its
     * block's offset instead of its offset within the block, and `Int.MAX_VALUE`
     * used as "the rest of this block" wrapping round - and neither needed a
     * device to catch. They only ever showed up as "nothing can be selected"
     * after a build and an install, which is a slow and unreliable way to find
     * out that two numbers were added in the wrong space.
     */
    testImplementation("junit:junit:4.13.2")
}
