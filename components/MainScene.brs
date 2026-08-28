sub init()

    m.address = m.top.findNode("address")
    m.status = m.top.findNode("status")
    m.pageBackground = m.top.findNode("pageBackground")

    m.serverUrl = "https://navegador-roku1-1.onrender.com"
    m.currentUrl = "https://www.google.com"

    m.top.setFocus(true)

    atualizarEndereco()

end sub


sub atualizarEndereco()

    m.address.text = m.currentUrl
    m.status.text = "Pronto"

end sub


function onKeyEvent(key as String, press as Boolean) as Boolean

    if not press
        return false
    end if

    if key = "OK"

        abrirPagina()
        return true

    else if key = "back"

        voltarPagina()
        return true

    else if key = "right"

        m.status.text = "Avançar"
        return true

    else if key = "left"

        m.status.text = "Voltar"
        return true

    else if key = "home"

        m.currentUrl = "https://www.google.com"
        atualizarEndereco()
        return true

    end if

    return true

end function


sub abrirPagina()

    m.status.text = "Abrindo página..."

    encodedUrl = m.currentUrl.Escape()

    url = m.serverUrl + "/browse?url=" + encodedUrl

    m.pageBackground.color = "0xFFFFFFFF"

    m.status.text = "Página: " + m.currentUrl

end sub


sub voltarPagina()

    m.currentUrl = "https://www.google.com"

    atualizarEndereco()

end sub
