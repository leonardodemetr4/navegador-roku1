sub init()

    m.siteView = m.top.findNode("siteView")
    m.address = m.top.findNode("address")

    ' IMPORTANTE:
    ' Depois do Render funcionar,
    ' trocaremos SEU-ENDERECO pelo endereço real.

    m.baseUrl = "https://SEU-ENDERECO.onrender.com/browse?url="

    m.currentUrl = "https://www.google.com"

    updateView()

end sub


sub updateView()

    m.address.text = m.currentUrl

    encoded = m.currentUrl.EncodeUriComponent()

    m.siteView.uri = m.baseUrl + encoded

end sub


function onKeyEvent(key as String, press as Boolean) as Boolean

    if not press then
        return true
    end if

    if key = "OK" then
        updateView()
        return true
    end if

    return true

end function
