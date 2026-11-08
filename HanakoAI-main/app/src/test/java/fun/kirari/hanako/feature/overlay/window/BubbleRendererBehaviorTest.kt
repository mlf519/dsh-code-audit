package `fun`.kirari.hanako.feature.overlay.window

import `fun`.kirari.hanako.feature.overlay.state.BubbleState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BubbleRendererBehaviorTest {

    @Test
    fun shouldShowSpinner_onlyForProcessingState() {
        assertTrue(BubbleRenderer.shouldShowSpinner(BubbleState.Processing))
        assertFalse(BubbleRenderer.shouldShowSpinner(BubbleState.Idle))
        assertFalse(BubbleRenderer.shouldShowSpinner(BubbleState.MultiPageCapturing(captureCount = 1)))
    }

    @Test
    fun getStateDescription_coversRepresentativeStates() {
        assertEquals("Idle", BubbleRenderer.getStateDescription(BubbleState.Idle))
        assertEquals("Copied(done)", BubbleRenderer.getStateDescription(BubbleState.Copied("done")))
        assertEquals(
            "ShowingLetters(AB)",
            BubbleRenderer.getStateDescription(BubbleState.ShowingLetters("AB"))
        )
        assertEquals(
            "MultiPageCapture(count=2)",
            BubbleRenderer.getStateDescription(BubbleState.MultiPageCapture(captureCount = 2))
        )
        assertEquals(
            "MenuExpanded(prev=Copied)",
            BubbleRenderer.getStateDescription(
                BubbleState.MenuExpanded(BubbleState.Copied("x"))
            )
        )
        assertEquals("Error(boom)", BubbleRenderer.getStateDescription(BubbleState.Error("boom")))
    }
}
